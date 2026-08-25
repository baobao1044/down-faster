/**
 * Đường tải một luồng cho server không chịu nói kích thước file.
 *
 * Hiện orchestrator ném lỗi khi `Content-Length` vắng mặt, tức là từ chối luôn
 * mọi phản hồi chunked. Thà tải một luồng còn hơn từ chối: người dùng cần file,
 * không cần tốc độ bằng mọi giá.
 *
 * Module này chạy trong ngữ cảnh engine host (offscreen/event page) chứ không
 * trong fetch worker, và ghi qua interface `StreamSink` thay vì đụng thẳng OPFS.
 * Nhờ vậy nó test được bằng sink giả mà vẫn tái dùng đúng giao thức
 * WriteRequest/WriteAck sẵn có qua `createPortSink()`.
 *
 * Hai cái bẫy được xử lý tường minh ở đây, vì cả hai đều tạo ra file hỏng lặng lẽ
 * — dạng lỗi tệ nhất, bởi file vẫn mở được:
 *   1. Xin `Range: bytes=5000-` mà server trả 200 nghĩa là body bắt đầu từ byte 0,
 *      trong khi ta đang đặt bút ở offset 5000.
 *   2. Nội dung bị nén trên đường truyền: fetch giải nén trước khi trả cho ta nên
 *      offset ta đếm là offset SAU giải nén, còn Range của server áp lên byte NÉN.
 */

import { resolveFilename } from '../filename';
import type { WriteAck, WriteRequest } from '../../shared/protocol';

export interface StreamSink {
  /** Trả về khi buffer đã được tiêu thụ — đây chính là điểm điều áp. */
  write(offset: number, chunk: Uint8Array): Promise<void>;
}

/** Tách phần dữ liệu thật ra một ArrayBuffer chuyển nhượng được. */
function toTransferable(chunk: Uint8Array): ArrayBuffer {
  const whole = chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength;
  return whole ? (chunk.buffer as ArrayBuffer) : (chunk.slice().buffer as ArrayBuffer);
}

/**
 * Sink nối vào writer worker qua đúng giao thức mà fetch worker đang dùng.
 *
 * Mạng thường nhanh hơn đĩa, nên không có van điều áp thì buffer chưa ghi sẽ
 * chất đống trong RAM và triệt tiêu đúng cái lợi mà OPFS mang lại.
 */
export function createPortSink(
  port: MessagePort,
  highWaterMark = 8 * 1024 * 1024,
): StreamSink & { dispose(): void } {
  let inflight = 0;
  let disposed = false;
  const waiters: Array<() => void> = [];

  const release = (): void => {
    while (waiters.length > 0 && (disposed || inflight < highWaterMark)) {
      waiters.shift()?.();
    }
  };

  port.onmessage = (event: MessageEvent<WriteAck>) => {
    inflight = Math.max(0, inflight - event.data.written);
    release();
  };
  port.start();

  return {
    async write(offset: number, chunk: Uint8Array): Promise<void> {
      if (disposed) throw new Error('Sink đã đóng');
      const buffer = toTransferable(chunk);
      const length = buffer.byteLength; // Phải đọc trước khi chuyển nhượng.
      inflight += length;
      port.postMessage({ offset, buffer } satisfies WriteRequest, [buffer]);
      if (inflight >= highWaterMark) {
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
    },
    dispose(): void {
      disposed = true;
      inflight = 0;
      release();
      port.onmessage = null;
    },
  };
}

export interface StreamInfo {
  finalUrl: string;
  mimeType: string | null;
  filename: string | null;
  etag: string | null;
  lastModified: string | null;
  /** Biết được nếu lần nối lại trả 206 kèm Content-Range. */
  totalSize: number | null;
  /** true thì `resumable` bắt buộc phải là false. */
  transportCompressed: boolean;
  acceptRanges: boolean;
}

export interface StreamRequest {
  url: string;
  /** Range và If-Range do module tự đặt; truyền vào sẽ bị bỏ qua. */
  headers?: Record<string, string>;
  etag?: string | null;
  lastModified?: string | null;
}

export interface StreamOptions {
  maxAttempts: number;
  backoffMs: number;
  maxBackoffMs: number;
  /** Không nhận byte nào trong bấy lâu thì coi như kết nối đã treo. */
  idleTimeoutMs: number;
  /** Phanh tay: một stream không biết kích thước về lý thuyết có thể vô tận. */
  maxBytes: number | null;
}

export const DEFAULT_STREAM: StreamOptions = {
  maxAttempts: 6,
  backoffMs: 1000,
  maxBackoffMs: 30000,
  idleTimeoutMs: 45000,
  maxBytes: null,
};

export interface StreamDeps {
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onProgress?: (bytes: number, offset: number) => void;
  onInfo?: (info: StreamInfo) => void;
  onNotice?: (message: string) => void;
}

export type StreamEnding = 'eof' | 'aborted' | 'error' | 'limit' | 'restart-needed';

export interface StreamOutcome {
  /** Chỉ true khi ending === 'eof'. Xem ghi chú về sự thật của chunked bên dưới. */
  completed: boolean;
  totalBytes: number;
  attempts: number;
  ending: StreamEnding;
  error: string | null;
  info: StreamInfo;
}

type AttemptResult =
  | { done: StreamEnding | 'paused'; reason?: string }
  | { retry: string }
  | { fatal: string };

/**
 * Gọi `fetch` tách rời khỏi global có thể ném "Illegal invocation" trong trình
 * duyệt (module ES chạy ở chế độ strict nên `this` là undefined), vì vậy mọi chỗ
 * dùng fetch mặc định đều đi qua bao bọc này.
 */
const globalFetch: typeof fetch = (...args: Parameters<typeof fetch>) => fetch(...args);

function isTransportCompressed(res: Response): boolean {
  const enc = res.headers.get('content-encoding');
  return !!enc && enc.trim().toLowerCase() !== 'identity';
}

function cancelBody(res: Response): void {
  res.body?.cancel().catch(() => {});
}

export function parseContentRange(
  value: string | null,
): { start: number; end: number; total: number | null } | null {
  if (!value) return null;
  const m = /^\s*bytes\s+(\d+)-(\d+)\/(\d+|\*)\s*$/i.exec(value);
  if (!m || !m[1] || !m[2] || !m[3]) return null;

  const start = Number(m[1]);
  const end = Number(m[2]);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;

  const totalRaw = m[3];
  if (totalRaw === '*') return { start, end, total: null };
  const total = Number(totalRaw);
  return { start, end, total: Number.isFinite(total) ? total : null };
}

// Phản hồi 416 mang Content-Range dạng `bytes */N` — cú pháp khác hẳn 206 nên
// parseContentRange() cố tình không nhận. N là độ dài thật của tài nguyên, thứ
// duy nhất phân biệt được "đã tải hết rồi" với "file vừa bị co lại".
export function parseUnsatisfiedTotal(value: string | null): number | null {
  if (!value) return null;
  const m = /^\s*bytes\s+\*\/(\d+)\s*$/i.exec(value);
  if (!m || !m[1]) return null;
  const total = Number(m[1]);
  return Number.isFinite(total) ? total : null;
}

export class StreamDownload {
  private readonly req: StreamRequest;
  private readonly sink: StreamSink;
  private readonly opts: StreamOptions;
  private readonly deps: StreamDeps;
  private readonly fetchImpl: typeof fetch;
  private readonly nowImpl: () => number;
  private readonly sleepImpl: (ms: number) => Promise<void>;

  private received = 0;
  private controller: AbortController | null = null;
  private stopped = false;
  private paused = false;
  private resumeWaiters: Array<() => void> = [];
  private backoffWaiters: Array<() => void> = [];

  private watchdogGen = 0;
  private idleTripped = false;
  private lastByteAt = 0;

  private streamInfo: StreamInfo;

  constructor(
    req: StreamRequest,
    sink: StreamSink,
    opts: Partial<StreamOptions> = {},
    deps: StreamDeps = {},
  ) {
    this.req = req;
    this.sink = sink;
    this.opts = { ...DEFAULT_STREAM, ...opts };
    this.deps = deps;
    this.fetchImpl = deps.fetch ?? globalFetch;
    this.nowImpl = deps.now ?? (() => Date.now());
    this.sleepImpl =
      deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

    this.streamInfo = {
      finalUrl: req.url,
      mimeType: null,
      filename: null,
      etag: req.etag ?? null,
      lastModified: req.lastModified ?? null,
      totalSize: null,
      transportCompressed: false,
      acceptRanges: false,
    };
  }

  get offset(): number {
    return this.received;
  }

  get info(): StreamInfo {
    return { ...this.streamInfo };
  }

  /** Tự nối lại cho tới khi EOF sạch, hết lượt thử, hoặc gặp ngõ cụt. */
  async run(): Promise<StreamOutcome> {
    let attempts = 0;

    for (;;) {
      await this.waitWhilePaused();
      if (this.stopped) return this.outcome('aborted', null, attempts);

      attempts += 1;
      const result = await this.runAttempt();

      if ('done' in result) {
        if (result.done === 'paused') {
          // Tạm dừng là ý người dùng, không phải một lần thử thất bại.
          attempts -= 1;
          continue;
        }
        return this.outcome(result.done, result.reason ?? null, attempts);
      }

      if ('fatal' in result) return this.outcome('error', result.fatal, attempts);

      // Nén trên đường truyền thì offset đã giải nén không ánh xạ được sang Range
      // của server. Nối lại sẽ ghi lệch và tạo ra file hỏng lặng lẽ, tệ hơn nhiều
      // so với tải lại từ đầu.
      if (this.streamInfo.transportCompressed && this.received > 0) {
        return this.outcome(
          'restart-needed',
          `nội dung bị nén nên không nối lại được (${result.retry})`,
          attempts,
        );
      }

      if (attempts >= this.opts.maxAttempts) {
        return this.outcome('error', result.retry, attempts);
      }

      const wait = Math.min(
        this.opts.maxBackoffMs,
        this.opts.backoffMs * Math.pow(2, attempts - 1),
      );
      this.notice(`Đứt ở byte ${this.received}: ${result.retry}. Thử lại sau ${wait}ms`);
      await this.backoff(wait);
    }
  }

  pause(): void {
    if (this.paused || this.stopped) return;
    this.paused = true;
    this.controller?.abort();
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.drainResumeWaiters();
  }

  abort(): void {
    this.stopped = true;
    this.paused = false;
    this.controller?.abort();
    this.drainResumeWaiters();
    this.drainBackoffWaiters();
  }

  /* ---------- Nội bộ ---------- */

  private drainResumeWaiters(): void {
    const waiters = this.resumeWaiters;
    this.resumeWaiters = [];
    for (const resolve of waiters) resolve();
  }

  private drainBackoffWaiters(): void {
    const waiters = this.backoffWaiters;
    this.backoffWaiters = [];
    for (const resolve of waiters) resolve();
  }

  /**
   * Chờ giữa hai lần thử, nhưng tỉnh dậy ngay nếu bị hủy.
   *
   * Backoff lên tới maxBackoffMs (mặc định 30 giây). Ngồi hết 30 giây rồi mới
   * nhận ra lượt tải đã bị hủy là giữ writer OPFS — thứ đang khóa độc quyền file
   * tạm — thêm 30 giây chẳng vì gì. CỐ Ý không đánh thức khi tạm dừng: người dùng
   * bấm tiếp không phải là lý do để bỏ qua hình phạt mà server vừa bắt phải chịu.
   */
  private async backoff(ms: number): Promise<void> {
    if (!(ms > 0) || this.stopped) return;
    await Promise.race([
      this.sleepImpl(ms),
      new Promise<void>((resolve) => this.backoffWaiters.push(resolve)),
    ]);
  }

  private async waitWhilePaused(): Promise<void> {
    while (this.paused && !this.stopped) {
      await new Promise<void>((resolve) => this.resumeWaiters.push(resolve));
    }
  }

  private notice(message: string): void {
    this.deps.onNotice?.(message);
  }

  private outcome(
    ending: StreamEnding,
    error: string | null,
    attempts: number,
  ): StreamOutcome {
    return {
      completed: ending === 'eof',
      totalBytes: this.received,
      attempts,
      ending,
      error,
      info: this.info,
    };
  }

  private buildHeaders(resuming: boolean): Headers {
    const headers = new Headers(this.req.headers ?? {});
    headers.delete('Range');
    headers.delete('If-Range');
    if (!resuming) return headers;

    headers.set('Range', `bytes=${this.received}-`);
    // If-Range biến "file đã đổi" thành 200 thay vì 206, tức là thành một lỗi ta
    // nhận ra được, thay vì thành một file ghép từ hai phiên bản khác nhau.
    const validator = this.streamInfo.etag ?? this.streamInfo.lastModified;
    if (validator) headers.set('If-Range', validator);
    return headers;
  }

  private absorbInfo(res: Response, resuming: boolean): void {
    const next: StreamInfo = { ...this.streamInfo };
    next.finalUrl = res.url || this.req.url;
    next.transportCompressed = isTransportCompressed(res);

    if (!resuming) {
      next.mimeType = res.headers.get('content-type');
      next.filename = resolveFilename(next.finalUrl, res.headers.get('content-disposition'));
      next.etag = res.headers.get('etag') ?? next.etag;
      next.lastModified = res.headers.get('last-modified') ?? next.lastModified;
    }

    const cr = parseContentRange(res.headers.get('content-range'));
    if (cr?.total != null) next.totalSize = cr.total;

    // Nội dung nén thì Range vô nghĩa với ta, dù server có nói hỗ trợ.
    next.acceptRanges =
      !next.transportCompressed &&
      (res.status === 206 || res.headers.get('accept-ranges')?.toLowerCase() === 'bytes');

    this.streamInfo = next;
    this.deps.onInfo?.(this.info);
  }

  /**
   * Watchdog dùng một hẹn giờ tại một thời điểm và kiểm tra mốc byte cuối, thay
   * vì đặt lại hẹn giờ sau mỗi chunk: cách sau tạo hàng nghìn timer treo trên
   * một kết nối nhanh.
   */
  private startWatchdog(): void {
    this.idleTripped = false;
    this.lastByteAt = this.nowImpl();
    if (!(this.opts.idleTimeoutMs > 0)) return;

    const gen = ++this.watchdogGen;
    const step = Math.max(50, Math.min(this.opts.idleTimeoutMs, 5000));
    void (async () => {
      while (this.watchdogGen === gen) {
        await this.sleepImpl(step);
        if (this.watchdogGen !== gen) return;
        if (this.nowImpl() - this.lastByteAt >= this.opts.idleTimeoutMs) {
          this.idleTripped = true;
          this.controller?.abort();
          return;
        }
      }
    })();
  }

  private stopWatchdog(): void {
    this.watchdogGen += 1;
  }

  private async runAttempt(): Promise<AttemptResult> {
    const resuming = this.received > 0;
    const controller = new AbortController();
    this.controller = controller;
    const signal = controller.signal;

    this.startWatchdog();
    try {
      let res: Response;
      try {
        res = await this.fetchImpl(this.streamInfo.finalUrl || this.req.url, {
          method: 'GET',
          headers: this.buildHeaders(resuming),
          credentials: 'include',
          cache: 'no-store',
          redirect: 'follow',
          signal,
        });
      } catch (err) {
        return this.classifyAbort() ?? { retry: describe(err) };
      }

      if (!res.ok) {
        cancelBody(res);

        // 416 lúc đang nối lại hầu như luôn có nghĩa "không còn gì để lấy nữa":
        // kết nối đứt đúng lúc byte cuối vừa tới nên lần thử sau xin một khoảng
        // nằm ngoài file. Coi đó là lỗi chết là vứt đi một file đã tải xong.
        if (res.status === 416 && resuming) {
          const total = parseUnsatisfiedTotal(res.headers.get('content-range'));
          if (total !== null && total === this.received) return { done: 'eof' };
          // Không có bằng chứng là đã đủ thì tải lại từ đầu, chứ tuyệt đối không
          // tuyên bố hoàn tất một file có thể đang thiếu.
          return {
            done: 'restart-needed',
            reason:
              total === null
                ? 'server từ chối khoảng byte mà không nói file dài bao nhiêu'
                : `server nói file dài ${total} byte, ta mới có ${this.received}`,
          };
        }

        const message = `HTTP ${res.status} ${res.statusText}`;
        const retryable = res.status >= 500 || res.status === 429 || res.status === 408;
        return retryable ? { retry: message } : { fatal: message };
      }

      if (resuming) {
        // Kiểm TRƯỚC khi ghi byte đầu tiên. Ghi rồi mới phát hiện là đã hỏng file.
        if (res.status !== 206) {
          cancelBody(res);
          return {
            done: 'restart-needed',
            reason: `server phớt lờ Range và trả lại từ đầu (HTTP ${res.status})`,
          };
        }
        const cr = parseContentRange(res.headers.get('content-range'));
        if (cr && cr.start !== this.received) {
          cancelBody(res);
          return {
            done: 'restart-needed',
            reason: `server trả từ byte ${cr.start} thay vì ${this.received}`,
          };
        }
      }

      this.absorbInfo(res, resuming);

      // Range của server áp lên byte ĐÃ NÉN, còn fetch giải nén trước khi trả cho
      // ta. Ghi tiếp ở offset cũ là dán byte đã giải nén vào giữa file — file vẫn
      // mở được nhưng nội dung sai, đúng dạng hỏng lặng lẽ mà module này tồn tại
      // để chặn. Phải kiểm SAU absorbInfo vì trước đó chưa đọc content-encoding.
      if (resuming && this.streamInfo.transportCompressed) {
        cancelBody(res);
        return {
          done: 'restart-needed',
          reason: 'phản hồi nối lại bị nén trên đường truyền nên offset không còn khớp',
        };
      }

      if (!res.body) return { retry: 'phản hồi không có body' };
      return await this.pump(res.body.getReader(), signal);
    } finally {
      this.stopWatchdog();
      this.controller = null;
    }
  }

  private classifyAbort(): AttemptResult | null {
    if (this.stopped) return { done: 'aborted' };
    if (this.paused) return { done: 'paused' };
    if (this.idleTripped) {
      return { retry: `không nhận được byte nào trong ${this.opts.idleTimeoutMs}ms` };
    }
    return null;
  }

  private async pump(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    signal: AbortSignal,
  ): Promise<AttemptResult> {
    // Một Response do test dựng bằng ReadableStream không tự phản ứng với
    // AbortController, nên chỉ chờ read() thì pause/abort/idle-timeout sẽ treo
    // mãi. Cách chữa là cancel() ngay khi có tín hiệu — cả body thật lẫn body
    // dựng tay đều tôn trọng nó, và nó giải phóng luôn read() đang chờ.
    //
    // CỐ Ý không đua Promise.race ở mỗi vòng lặp: mỗi lần đua gắn thêm một phản
    // ứng vào promise hủy chưa bao giờ settle, khoảng 66 byte mỗi chunk và không
    // bao giờ được thu hồi cho tới hết lần thử. Một file 20 GB chia chunk 64 KiB
    // là hơn 80 MB rác treo — đúng thứ RAM mà cả đường ghi OPFS sinh ra để tránh.
    const onAbort = (): void => {
      reader.cancel().catch(() => {});
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });

    try {
      return await this.pumpLoop(reader);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  private async pumpLoop(
    reader: ReadableStreamDefaultReader<Uint8Array>,
  ): Promise<AttemptResult> {
    for (;;) {
      let step: ReadableStreamReadResult<Uint8Array>;
      try {
        step = await reader.read();
      } catch (err) {
        return this.classifyAbort() ?? { retry: describe(err) };
      }

      // cancel() làm read() đang chờ resolve thành done, nên "server đóng sạch"
      // và "ta vừa cắt kết nối" tới đây trông giống hệt nhau. Phải hỏi lý do
      // trước khi mừng: tuyên bố eof cho một lần hủy là giao file thiếu.
      if (step.done) return this.classifyAbort() ?? { done: 'eof' };
      const value = step.value;
      if (!value || value.byteLength === 0) continue;

      let chunk = value;
      if (this.opts.maxBytes !== null) {
        const room = this.opts.maxBytes - this.received;
        if (room <= 0) {
          reader.cancel().catch(() => {});
          return { done: 'limit' };
        }
        if (chunk.byteLength > room) chunk = chunk.subarray(0, room);
      }

      const offset = this.received;
      const length = chunk.byteLength; // Sink có thể chuyển nhượng buffer, đọc trước.
      try {
        await this.sink.write(offset, chunk);
      } catch (err) {
        reader.cancel().catch(() => {});
        return { fatal: `không ghi được vào file tạm: ${describe(err)}` };
      }

      this.received += length;
      this.lastByteAt = this.nowImpl();
      this.deps.onProgress?.(length, this.received);

      if (this.opts.maxBytes !== null && this.received >= this.opts.maxBytes) {
        reader.cancel().catch(() => {});
        return { done: 'limit' };
      }
    }
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Suffix range: một request cho biết cả tổng kích thước lẫn khả năng Range.
 *
 * probe.ts chỉ thử `bytes=0-0`. Không ít proxy và CDN phớt lờ range bắt đầu từ 0
 * nhưng lại tôn trọng suffix range và trả `Content-Range: bytes N-N/TOTAL`. Trúng
 * một phát là lượt tải đang định chạy một luồng được nâng cấp thành nhiều luồng.
 */
export async function discoverTotalSize(
  url: string,
  headers: Record<string, string> = {},
  fetchImpl: typeof fetch = globalFetch,
): Promise<{ total: number | null; acceptRanges: boolean; finalUrl: string }> {
  const h = new Headers(headers);
  h.set('Range', 'bytes=-1');

  const res = await fetchImpl(url, {
    method: 'GET',
    headers: h,
    credentials: 'include',
    cache: 'no-store',
    redirect: 'follow',
  });
  cancelBody(res);

  const finalUrl = res.url || url;

  if (res.status === 206) {
    const cr = parseContentRange(res.headers.get('content-range'));
    return { total: cr?.total ?? null, acceptRanges: true, finalUrl };
  }

  if (!res.ok) return { total: null, acceptRanges: false, finalUrl };

  // 200 nghĩa là suffix range bị phớt lờ, nhưng Content-Length lúc này lại là
  // kích thước cả file — trừ khi nội dung bị nén, khi đó nó là kích thước đã nén
  // và hoàn toàn vô dụng với ta.
  if (isTransportCompressed(res)) return { total: null, acceptRanges: false, finalUrl };

  const raw = res.headers.get('content-length');
  const total = raw === null ? NaN : Number(raw);
  return {
    total: Number.isFinite(total) && total >= 0 ? total : null,
    acceptRanges: res.headers.get('accept-ranges')?.toLowerCase() === 'bytes',
    finalUrl,
  };
}

/** Xác nhận server cho tiếp tục từ offset trước khi hứa "tạm dừng được" với người dùng. */
export async function canResumeFrom(
  url: string,
  offset: number,
  validators: { etag?: string | null; lastModified?: string | null },
  fetchImpl: typeof fetch = globalFetch,
): Promise<boolean> {
  if (offset <= 0) return true;

  const h = new Headers();
  h.set('Range', `bytes=${offset}-`);
  const validator = validators.etag ?? validators.lastModified;
  if (validator) h.set('If-Range', validator);

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      headers: h,
      credentials: 'include',
      cache: 'no-store',
      redirect: 'follow',
    });
  } catch {
    return false;
  }
  cancelBody(res);

  if (res.status !== 206) return false;
  if (isTransportCompressed(res)) return false;

  const cr = parseContentRange(res.headers.get('content-range'));
  return cr === null ? true : cr.start === offset;
}
