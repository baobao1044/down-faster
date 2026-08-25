/// <reference lib="webworker" />
import type { FetchCommand, FetchEvent, WriteAck, WriteRequest } from '../../shared/protocol';
import { ThrottleClient } from '../throttle';

/**
 * Một kết nối tải. Worker này bốc từng piece, kéo body theo dòng và đẩy thẳng
 * sang writer worker, không bao giờ giữ cả piece trong bộ nhớ.
 */

const scope = self as unknown as DedicatedWorkerGlobalScope;

/** Gửi tiến độ theo nhịp thay vì theo từng chunk, tránh ngập luồng chính. */
const PROGRESS_INTERVAL_MS = 250;

let writerPort: MessagePort | null = null;
let highWaterMark = 8 * 1024 * 1024;
let controller: AbortController | null = null;

/**
 * Hạn mức tốc độ.
 *
 * Xô token nằm ở host chứ không ở đây: người dùng đặt "500 KB/s" là nói cho cả
 * extension, nên tám worker chia chung một xô mới ra đúng con số đó. Worker chỉ
 * giữ phần dư của mình và xin thêm khi cạn.
 */
let throttle = new ThrottleClient({
  ask: () => emit({ type: 'quota-ask' }),
  limited: true,
});

/* ---------- Điều áp ---------- */

// Mạng thường nhanh hơn đĩa. Không chặn lại thì buffer chưa ghi sẽ chất đống
// trong RAM và triệt tiêu đúng cái lợi mà OPFS mang lại.
let inflight = 0;
const waiters: Array<() => void> = [];

function releaseWaiters(): void {
  while (waiters.length && inflight < highWaterMark) {
    waiters.shift()?.();
  }
}

function reserve(bytes: number): Promise<void> {
  inflight += bytes;
  if (inflight < highWaterMark) return Promise.resolve();
  return new Promise<void>((resolve) => waiters.push(resolve));
}

function onAck(event: MessageEvent<WriteAck>): void {
  inflight = Math.max(0, inflight - event.data.written);
  releaseWaiters();
}

/* ---------- Tải một piece ---------- */

class PieceError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    /** Mã HTTP nếu lỗi đến từ phản hồi; bộ điều khiển thích nghi đọc con số này. */
    readonly status: number | null = null,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
  }
}

function emit(event: FetchEvent): void {
  scope.postMessage(event);
}

/** Tách phần dữ liệu thật ra một ArrayBuffer chuyển nhượng được. */
function toTransferable(chunk: Uint8Array): ArrayBuffer {
  const sameSize = chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength;
  return sameSize
    ? (chunk.buffer as ArrayBuffer)
    : (chunk.slice().buffer as ArrayBuffer);
}

async function downloadPiece(cmd: Extract<FetchCommand, { type: 'piece' }>): Promise<void> {
  const port = writerPort;
  if (!port) throw new PieceError('Chưa nối được với writer worker', false);

  const expected = cmd.end - cmd.start + 1;
  if (expected <= 0) {
    emit({ type: 'done', pieceIndex: cmd.pieceIndex, bytes: 0 });
    return;
  }

  controller = new AbortController();
  const headers = new Headers(cmd.headers ?? {});
  headers.set('Range', `bytes=${cmd.start}-${cmd.end}`);

  let res: Response;
  try {
    res = await fetch(cmd.url, {
      method: 'GET',
      headers,
      credentials: 'include',
      cache: 'no-store',
      redirect: 'follow',
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) throw new PieceError('Đã hủy', false);
    throw new PieceError(err instanceof Error ? err.message : String(err), true);
  }

  if (res.status === 206) {
    // Đúng như mong đợi.
  } else if (res.status === 200 && cmd.start === 0) {
    // Server phớt lờ Range nhưng piece này bắt đầu từ 0 nên vẫn dùng được.
  } else if (res.status === 200) {
    // Nhận nguyên file cho một piece ở giữa: ghi vào sẽ hỏng dữ liệu.
    res.body?.cancel().catch(() => {});
    throw new PieceError('Server không tôn trọng header Range', false);
  } else if (res.status === 416) {
    res.body?.cancel().catch(() => {});
    throw new PieceError('Khoảng byte không hợp lệ (416)', false, 416);
  } else if (!res.ok) {
    res.body?.cancel().catch(() => {});
    // 5xx và 429 thường chỉ là tạm thời; 4xx còn lại thì thử lại cũng vô ích.
    const retryable = res.status >= 500 || res.status === 429 || res.status === 408;
    throw new PieceError(
      `HTTP ${res.status} ${res.statusText}`,
      retryable,
      res.status,
      retryAfterMs(res.headers.get('retry-after')),
    );
  }

  if (!res.body) throw new PieceError('Phản hồi không có body', true);

  const reader = res.body.getReader();
  let offset = cmd.start;
  let received = 0;
  let lastReport = 0;
  let sinceReport = 0;

  try {
    for (;;) {
      // Xin hạn mức TRƯỚC khi đọc: không thể biết chunk kế tiếp dài bao nhiêu, nên
      // xin trước rồi trừ sau, sai số bị chặn ở đúng một chunk cho mỗi worker.
      await throttle.request();
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;

      // Server rộng tay hơn yêu cầu thì cắt bớt, không để tràn sang piece kế.
      const room = expected - received;
      if (room <= 0) break;
      const chunk = value.byteLength > room ? value.subarray(0, room) : value;
      throttle.account(value.byteLength);

      const buffer = toTransferable(chunk);
      const length = buffer.byteLength; // Phải đọc trước khi chuyển nhượng.

      await reserve(length);
      port.postMessage({ offset, buffer } satisfies WriteRequest, [buffer]);

      offset += length;
      received += length;
      sinceReport += length;

      const now = Date.now();
      if (now - lastReport >= PROGRESS_INTERVAL_MS) {
        emit({ type: 'progress', pieceIndex: cmd.pieceIndex, bytes: sinceReport });
        sinceReport = 0;
        lastReport = now;
      }
    }
  } catch (err) {
    // Chốt sổ phần đã ghi được trước khi báo lỗi: nhờ vậy lần thử lại nối tiếp
    // từ đúng chỗ đứt thay vì kéo lại từ đầu piece.
    if (sinceReport > 0) {
      emit({ type: 'progress', pieceIndex: cmd.pieceIndex, bytes: sinceReport });
      sinceReport = 0;
    }
    if (controller.signal.aborted) throw new PieceError('Đã hủy', false);
    throw new PieceError(err instanceof Error ? err.message : String(err), true);
  }

  if (sinceReport > 0) {
    emit({ type: 'progress', pieceIndex: cmd.pieceIndex, bytes: sinceReport });
  }

  if (received < expected) {
    // Kết nối đứt giữa chừng: phần đã ghi vẫn dùng được, orchestrator sẽ nối tiếp.
    throw new PieceError(`Thiếu ${expected - received} byte`, true);
  }

  emit({ type: 'done', pieceIndex: cmd.pieceIndex, bytes: received });
}

/**
 * Retry-After ở dạng số giây hoặc mốc thời gian HTTP. Chỉ cần đủ đúng để bộ điều
 * khiển thích nghi biết nên nghỉ bao lâu, nên phân tích ở đây cho gọn thay vì
 * kéo cả module concurrency vào tsconfig của worker.
 */
function retryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const raw = value.trim();
  if (raw === '') return null;
  if (/^\d+$/.test(raw)) {
    const seconds = Number(raw);
    return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : null;
  }
  const hasZone = /(?:GMT|UTC|Z|[+-]\d{2}:?\d{2})\s*$/i.test(raw);
  const at = Date.parse(hasZone ? raw : `${raw} GMT`);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, at - Date.now());
}

/* ---------- Vòng lệnh ---------- */

scope.onmessage = (event: MessageEvent<FetchCommand>) => {
  const msg = event.data;

  if (msg.type === 'init') {
    highWaterMark = msg.highWaterMark;
    throttle = new ThrottleClient({
      ask: () => emit({ type: 'quota-ask' }),
      limited: msg.limited !== false,
    });
    const port = event.ports[0];
    if (port) {
      writerPort = port;
      port.onmessage = onAck;
      port.start();
    }
    return;
  }

  if (msg.type === 'quota') {
    throttle.onGrant(msg.bytes);
    return;
  }

  if (msg.type === 'abort') {
    controller?.abort();
    // Piece có thể đang nằm chờ biên nhận hoặc chờ hạn mức. Mở cả hai van ra,
    // nếu không nó treo mãi và worker không bao giờ nhận piece mới.
    inflight = 0;
    releaseWaiters();
    throttle.reset();
    emit({ type: 'aborted' });
    return;
  }

  if (msg.type === 'piece') {
    void downloadPiece(msg).catch((err: unknown) => {
      const known = err instanceof PieceError ? err : null;
      emit({
        type: 'failed',
        pieceIndex: msg.pieceIndex,
        message: err instanceof Error ? err.message : String(err),
        retryable: known ? known.retryable : true,
        status: known?.status ?? null,
        retryAfterMs: known?.retryAfterMs ?? null,
      });
    });
  }
};
