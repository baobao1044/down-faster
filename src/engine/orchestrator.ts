import { probe } from './probe';
import {
  isComplete,
  planPieces,
  remainingRange,
  requeue,
  takeNextPending,
  totalReceived,
} from './pieces';
import { unfitForAcceleration } from './policy';
import * as storage from './storage';
import { DEFAULT_OPTIONS } from './types';
import type {
  DownloadOptions,
  DownloadState,
  DownloadTask,
  Progress,
  TaskSource,
} from './types';
import type {
  FetchCommand,
  FetchEvent,
  WriterCommand,
  WriterEvent,
} from '../shared/protocol';
import {
  ConcurrencyController,
  pressureFromStatus,
  type ConcurrencyOptions,
} from './adaptive/concurrency';
import {
  MirrorPool,
  compareFingerprints,
  sameOriginUrls,
  verifyByContent,
  type MirrorFailure,
  type MirrorFingerprint,
  type RangeReader,
} from './adaptive/mirrors';
import { createPortSink, StreamDownload } from './adaptive/streaming';
import { nextTier, type ReplayTier } from './adaptive/headers';
import type { ResumeSeed } from './persistence';
import { runtimeUrl } from '../platform/api';
import { requireStorage } from '../platform/capabilities';
import { log, warn } from '../shared/log';

export interface CompletedFile {
  blobUrl: string;
  filename: string;
  size: number;
  mimeType: string | null;
}

export interface JobEvents {
  onProgress?: (progress: Progress) => void;
  onState?: (state: DownloadState, error: string | null) => void;
  onComplete?: (file: CompletedFile) => void;
  /**
   * Engine bỏ cuộc và muốn trình duyệt tải theo cách thường.
   *
   * Đây là lưới an toàn của chế độ tự động: đã giành lượt tải của người dùng thì
   * phải giao được file, và người không rành công nghệ không có cách nào tự cứu
   * khi engine hỏng. Thà tải chậm còn hơn mất file.
   */
  onHandBack?: (reason: string) => void;
  /**
   * Tiến độ đáng chốt sổ xuống đĩa.
   *
   * Job không tự biết mình được lưu ở đâu — nó chỉ báo "có gì đó đổi", còn nhịp
   * ghi và ngưỡng byte là việc của TaskPersistence.
   */
  onCheckpoint?: (task: DownloadTask) => void;
}

/** Cửa xin hạn mức tốc độ. Xô token nằm ở manager vì nó chung cho cả extension. */
export interface ThrottlePort {
  attach(clientId: string, grant: (bytes: number) => void): void;
  detach(clientId: string): void;
  ask(clientId: string): void;
}

/**
 * Cửa phát lại các header mà `fetch` cấm đặt.
 *
 * Job chỉ nói "tôi cần bậc 2 cho URL này"; việc dựng luật declarativeNetRequest
 * và xin trình duyệt cài nó thuộc về manager, vì offscreen không có quyền đó.
 */
export interface HeaderPort {
  /** Có bắt được header nào cho URL này không; quyết định có leo bậc hay không. */
  has(url: string): boolean;
  /** Cài luật ở bậc `tier`, trả về phần header đặt thẳng được qua `fetch`. */
  arm(taskId: string, url: string, tier: ReplayTier): Promise<Record<string, string>>;
  disarm(taskId: string): void;
}

export interface JobDeps {
  throttle?: ThrottlePort;
  headers?: HeaderPort;
  /** Tiến độ còn lại từ phiên trước; có nó thì bỏ qua bước thăm dò. */
  resume?: ResumeSeed | null;
}

/** Phần chung giữa một lượt tải file và một lượt ghép luồng media. */
export interface Job {
  readonly task: DownloadTask;
  start(): Promise<void>;
  pause(): void;
  resume(): void;
  cancel(): Promise<void>;
}

/** Cửa sổ trượt để ước lượng tốc độ; ngắn quá thì nhảy loạn, dài quá thì ì. */
const SPEED_WINDOW_MS = 3000;

/** Các mã mà server dùng để nói "thiếu Referer" hoặc "không phải nguồn hợp lệ". */
const DENIED_STATUSES = new Set([401, 403, 451]);

interface Sample {
  at: number;
  bytes: number;
}

/** Nguồn đang phục vụ một worker, kèm mốc thời gian để tính tốc độ từng nguồn. */
interface Lease {
  mirrorId: string;
  url: string;
  startedAt: number;
  lastAt: number;
  bytes: number;
}

/**
 * Quy lỗi của một piece về loại sự cố mà MirrorPool hiểu.
 *
 * Xuất ra để test được: đoán nhầm 'notfound' thành 'network' sẽ giữ mãi một
 * nguồn đã chết, còn nhầm chiều ngược lại thì loại oan một nguồn chỉ chập chờn.
 */
export function failureKind(status: number | null, message: string): MirrorFailure {
  if (status === 404 || status === 410) return 'notfound';
  if (status === 429 || status === 503 || status === 509) return 'throttled';
  if (status === 408 || status === 504) return 'timeout';
  if (/không tôn trọng header Range|Khoảng byte không hợp lệ/i.test(message)) return 'mismatch';
  return 'network';
}

/**
 * Một file đang tải, cùng đội worker phục vụ nó.
 *
 * Orchestrator giữ toàn bộ trạng thái piece và chỉ phát việc cho worker nào rảnh.
 * Worker cố tình được viết ngu ngơ: chúng không biết gì về hàng đợi hay retry,
 * nhờ vậy mọi quyết định về tính đúng đắn nằm gọn ở một chỗ.
 */
export class DownloadJob implements Job {
  readonly task: DownloadTask;

  private readonly options: DownloadOptions;
  private readonly events: JobEvents;
  private readonly deps: JobDeps;

  private writer: Worker | null = null;
  private fetchers: Worker[] = [];
  /** Worker nào đang giữ piece nào, để trả piece về hàng chờ khi worker chết. */
  private assignment = new Map<number, number>();
  private leases = new Map<number, Lease>();
  private samples: Sample[] = [];
  private stopping = false;
  private finished = false;
  private progressTimer: ReturnType<typeof setInterval> | null = null;

  /** Bộ dò số kết nối; chỉ dựng sau khi thăm dò xong vì cần biết trần thật. */
  private pace: ConcurrencyController | null = null;
  private mirrors: MirrorPool | null = null;
  private tier: ReplayTier = 0;
  private replayHeaders: Record<string, string> = {};
  /** Đường tải cho file không rõ kích thước; loại trừ với đường piece. */
  private stream: StreamDownload | null = null;
  private streamSink: { dispose(): void } | null = null;

  constructor(
    url: string,
    options: Partial<DownloadOptions> = {},
    events: JobEvents = {},
    source: TaskSource = 'manual',
    deps: JobDeps = {},
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.events = events;
    this.deps = deps;

    const seed = deps.resume ?? null;
    this.task = {
      id: seed?.id ?? crypto.randomUUID(),
      source: seed?.source ?? source,
      url: seed?.url ?? url,
      finalUrl: seed?.finalUrl ?? url,
      filename: seed?.filename ?? 'download',
      size: seed?.size ?? null,
      state: 'queued',
      received: seed?.received ?? 0,
      pieces: seed?.pieces ?? [],
      error: null,
      createdAt: seed?.createdAt ?? Date.now(),
      speed: 0,
      acceptRanges: seed?.acceptRanges ?? false,
      etag: seed?.etag ?? null,
      lastModified: seed?.lastModified ?? null,
      mimeType: seed?.mimeType ?? null,
    };
  }

  /* ---------- Vòng đời ---------- */

  async start(): Promise<void> {
    try {
      // Khôi phục: kích thước, tên và bản đồ piece đã có sẵn từ phiên trước, nên
      // thăm dò lại chỉ tổ mất một vòng mạng và có nguy cơ nhận URL đã hết hạn.
      if (this.deps.resume) {
        await this.beginTransfer(this.deps.resume.size, true);
        return;
      }

      this.setState('probing');
      await this.armHeaders();
      const info = await probe(this.task.url, { headers: this.replayHeaders });

      this.task.finalUrl = info.finalUrl;
      this.task.filename = info.filename;
      this.task.size = info.size;
      this.task.acceptRanges = info.acceptRanges;
      this.task.etag = info.etag;
      this.task.lastModified = info.lastModified;
      this.task.mimeType = info.mimeType;

      // Chế độ tự động chỉ nên giữ những gì nó thật sự làm nhanh hơn. Không chia
      // luồng được, hoặc file quá nhỏ để bõ, thì trả ngay về cho trình duyệt.
      const unfit = unfitForAcceleration(
        info.size,
        info.acceptRanges,
        this.options.minAccelerateSize,
      );
      const streamable = info.size === null && this.options.allowStreaming;
      if (unfit && this.task.source === 'auto' && !streamable) {
        this.handBack(unfit);
        return;
      }

      if (info.size === null) {
        if (!this.options.allowStreaming) {
          throw new Error('Server không cho biết kích thước file');
        }
        await this.runStream();
        return;
      }

      await this.ensureQuota(info.size);
      this.task.pieces = planPieces(info.size, {
        ...this.options,
        connections: info.acceptRanges ? this.options.connections : 1,
      });
      await this.beginTransfer(info.size, false);
    } catch (err) {
      await this.fail(err instanceof Error ? err.message : String(err));
    }
  }

  /** Phần chung của lượt tải mới và lượt khôi phục: mở writer rồi chạy. */
  private async beginTransfer(size: number, resuming: boolean): Promise<void> {
    this.setupPace();
    this.setupMirrors();

    await this.openWriter(size);
    this.spawnFetchers();
    this.setState('downloading');
    this.startProgressTicker();
    this.events.onCheckpoint?.(this.task);
    log(
      'job',
      resuming
        ? `khôi phục ${this.task.filename}: còn ${size - this.task.received} byte`
        : `bắt đầu ${this.task.filename}`,
    );
    this.pump();
  }

  pause(): void {
    if (this.task.state !== 'downloading') return;
    this.stopping = true;
    this.stream?.pause();
    this.abortFetchers();
    // Piece đang dở quay về hàng chờ; phần byte đã ghi vẫn giữ nguyên trên đĩa.
    for (const piece of this.task.pieces) {
      if (piece.state === 'active') piece.state = 'pending';
    }
    this.releaseAllLeases();
    this.assignment.clear();
    this.stopProgressTicker();
    this.setState('paused');
    this.events.onCheckpoint?.(this.task);
    this.stopping = false;
  }

  resume(): void {
    if (this.task.state !== 'paused') return;
    this.setState('downloading');
    this.startProgressTicker();
    if (this.stream) {
      this.stream.resume();
      return;
    }
    this.pump();
  }

  async cancel(): Promise<void> {
    this.stopping = true;
    this.stream?.abort();
    this.abortFetchers();
    this.stopProgressTicker();
    await this.teardown();
    await storage.removePart(this.task.id);
    this.setState('canceled');
  }

  /* ---------- Chuẩn bị ---------- */

  private handBack(reason: string): void {
    this.finished = true;
    this.stopProgressTicker();
    this.detachAll();
    this.setState('canceled');
    log('job', `trả lại cho trình duyệt: ${reason}`);
    this.events.onHandBack?.(reason);
  }

  private setupPace(): void {
    if (!this.options.adaptiveConnections) return;
    this.pace = new ConcurrencyController(
      paceOptionsFor(this.options, this.task.pieces.length),
    );
  }

  private setupMirrors(): void {
    const extra = (this.options.mirrors ?? []).filter((u) => u && u !== this.task.finalUrl);
    if (extra.length === 0) return;

    // Trần của MỘT nguồn phải bằng trần của cả lượt tải: pool cũng là đường đi của
    // lượt tải một nguồn, để thấp hơn là âm thầm bóp mọi lượt tải bình thường.
    this.mirrors = new MirrorPool([], { maxPerMirror: this.options.connections });
    const fingerprint: MirrorFingerprint = {
      size: this.task.size,
      etag: this.task.etag,
      lastModified: this.task.lastModified,
      acceptRanges: this.task.acceptRanges,
    };
    this.mirrors.add({ id: 'origin', url: this.task.finalUrl, priority: 1 }, fingerprint);

    // Nguồn phụ KHÔNG vào pool ngay. Hai URL người dùng tin là cùng một file mà
    // thật ra khác nhau sẽ ghép ra một file hỏng không báo lỗi gì — đúng thứ tệ
    // nhất có thể xảy ra. Việc tải cứ chạy trên nguồn chính trong lúc chờ.
    void this.verifyMirrors(extra, fingerprint);
  }

  /** Đọc một khoảng byte, dùng cho phép lấy mẫu nội dung khi so hai nguồn. */
  private rangeReader(): RangeReader {
    return async (url, start, end) => {
      const res = await fetch(url, {
        headers: { ...this.replayHeaders, Range: `bytes=${start}-${end}` },
        credentials: 'include',
        cache: 'no-store',
        redirect: 'follow',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    };
  }

  private async verifyMirrors(urls: string[], reference: MirrorFingerprint): Promise<void> {
    const read = this.rangeReader();

    await Promise.all(
      urls.map(async (url, index) => {
        try {
          const info = await probe(url, { headers: this.replayHeaders });
          const candidate: MirrorFingerprint = {
            size: info.size,
            etag: info.etag,
            lastModified: info.lastModified,
            acceptRanges: info.acceptRanges,
          };

          let check = compareFingerprints(
            reference,
            candidate,
            sameOriginUrls(this.task.finalUrl, info.finalUrl),
          );

          // 'likely' là "kích thước khớp nhưng không có bằng chứng về byte". Với
          // việc chia piece giữa hai nguồn thì bấy nhiêu là chưa đủ, nên bỏ ra
          // 192 KiB mỗi bên để lấy mẫu đầu, giữa và cuối. Rẻ hơn nhiều so với
          // tải xong nửa file rồi mới biết hai bản không khớp.
          if (check.verdict === 'likely' && reference.size !== null && candidate.size !== null) {
            check = await verifyByContent(
              { url: this.task.finalUrl, size: reference.size },
              { url: info.finalUrl, size: candidate.size },
              read,
            );
          }

          if (check.verdict !== 'same') {
            log('job', `bỏ nguồn ${url}: ${check.reason}`);
            return;
          }

          this.mirrors?.add({ id: `m${index}`, url: info.finalUrl }, candidate);
          log('job', `thêm nguồn ${info.finalUrl}: ${check.reason}`);
        } catch (err) {
          warn('job', `không kiểm được nguồn ${url}`, err);
        }
      }),
    );

    if (this.mirrors && this.mirrors.size > 1) this.pump();
  }

  /** Xin manager cài luật header cho bậc hiện tại; thất bại thì chạy không có. */
  private async armHeaders(): Promise<void> {
    const port = this.deps.headers;
    if (!port || this.tier === 0) {
      this.replayHeaders = {};
      return;
    }
    try {
      this.replayHeaders = await port.arm(this.task.id, this.task.url, this.tier);
    } catch (err) {
      warn('job', 'không cài được luật header', err);
      this.replayHeaders = {};
    }
  }

  private async ensureQuota(size: number): Promise<void> {
    try {
      const info = await storage.quota();
      // File nằm trên đĩa hai lần trong chốc lát: bản tạm và bản đích.
      if (info.quota > 0 && info.available < size) {
        throw new Error(
          `Không đủ dung lượng tạm: cần ${formatBytes(size)}, còn ${formatBytes(info.available)}`,
        );
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Không đủ dung lượng')) throw err;
      // estimate() hỏng thì cứ thử tải, lỗi thật sẽ lộ ra lúc ghi.
    }
  }

  private async openWriter(size: number): Promise<void> {
    // Chốt chặn duy nhất trước khi đụng tới đĩa. Mọi đường tải — file thường,
    // khôi phục, hay luồng không rõ kích thước — đều đi qua đây.
    await requireStorage();

    return new Promise((resolve, reject) => {
      const worker = new Worker(runtimeUrl('writer-worker.js'), { type: 'module' });
      this.writer = worker;

      worker.onmessage = (event: MessageEvent<WriterEvent>) => {
        const msg = event.data;
        if (msg.type === 'ready') resolve();
        else if (msg.type === 'error') {
          warn('writer', msg.message);
          void this.fail(`Lỗi ghi file tạm: ${msg.message}`);
        }
      };
      worker.onerror = (e) => reject(new Error(e.message || 'Writer worker gặp lỗi'));

      const cmd: WriterCommand = {
        type: 'open',
        fileName: storage.partName(this.task.id),
        size,
      };
      worker.postMessage(cmd);
    });
  }

  private clientId(index: number): string {
    return `${this.task.id}#${index}`;
  }

  private spawnFetchers(): void {
    const count = Math.max(
      1,
      Math.min(this.options.connections, this.task.pieces.length),
    );

    for (let i = 0; i < count; i++) {
      const worker = new Worker(runtimeUrl('fetch-worker.js'), { type: 'module' });
      worker.onmessage = (event: MessageEvent<FetchEvent>) => this.onFetchEvent(i, event.data);
      worker.onerror = (e) => {
        warn('fetcher', i, e.message);
        this.releaseAssignment(i, true);
        this.pump();
      };

      // Kênh riêng nối thẳng fetch worker với writer, không đi vòng qua luồng này.
      const channel = new MessageChannel();
      this.writer?.postMessage({ type: 'attach' } satisfies WriterCommand, [channel.port1]);
      worker.postMessage(
        {
          type: 'init',
          highWaterMark: this.options.writeHighWaterMark,
          limited: this.deps.throttle !== undefined,
        } satisfies FetchCommand,
        [channel.port2],
      );

      this.deps.throttle?.attach(this.clientId(i), (bytes) =>
        worker.postMessage({ type: 'quota', bytes } satisfies FetchCommand),
      );

      this.fetchers.push(worker);
    }
    log('job', `${count} kết nối cho ${this.task.pieces.length} piece`);
  }

  /* ---------- Phát việc ---------- */

  /** Số worker được phép chạy ngay lúc này. */
  private allowance(): number {
    if (!this.pace) return this.fetchers.length;
    return Math.min(this.fetchers.length, this.pace.allowedAt(Date.now()));
  }

  /**
   * Phát việc cho mọi worker rảnh trong hạn mức.
   *
   * Bộ dò có thể nới hạn mức bất cứ lúc nào, mà worker rảnh thì không tự biết
   * điều đó. Gọi lại từ đầu danh sách sau mỗi sự kiện là cách đơn giản nhất để
   * không bỏ sót một worker vừa được phép chạy.
   */
  private pump(): void {
    if (this.stopping || this.finished) return;
    if (this.task.state !== 'downloading') return;

    const allowed = this.allowance();
    for (let i = 0; i < allowed; i++) {
      if (this.assignment.has(i)) continue;
      if (!this.dispatch(i)) break;
    }
    if (this.assignment.size === 0 && allowed > 0) this.maybeFinish();
  }

  /** false nghĩa là hết piece để phát, đừng thử worker tiếp theo nữa. */
  private dispatch(workerIndex: number): boolean {
    const worker = this.fetchers[workerIndex];
    if (!worker) return false;

    const piece = takeNextPending(this.task.pieces);
    if (!piece) return false;

    const now = Date.now();
    let url = this.task.finalUrl;
    if (this.mirrors) {
      const source = this.mirrors.acquire({ requireRanges: this.task.acceptRanges });
      if (source) {
        url = source.url;
        this.leases.set(workerIndex, {
          mirrorId: source.id,
          url,
          startedAt: now,
          lastAt: now,
          bytes: 0,
        });
      }
    }

    this.assignment.set(workerIndex, piece.index);
    const { start, end } = remainingRange(piece);

    const headers: Record<string, string> = { ...this.replayHeaders };
    // If-Range biến việc file đổi giữa chừng thành lỗi rõ ràng thay vì file hỏng:
    // server sẽ trả 200 thay vì 206, và fetch worker từ chối ghi.
    const lease = this.leases.get(workerIndex);
    const validator = lease ? this.mirrors?.validatorFor(lease.mirrorId) ?? null : null;
    const etag = validator ? validator.etag : this.task.etag;
    const lastModified = validator ? validator.lastModified : this.task.lastModified;
    if (etag) headers['If-Range'] = etag;
    else if (lastModified) headers['If-Range'] = lastModified;

    worker.postMessage({
      type: 'piece',
      pieceIndex: piece.index,
      url,
      start,
      end,
      headers,
    } satisfies FetchCommand);
    return true;
  }

  private onFetchEvent(workerIndex: number, event: FetchEvent): void {
    switch (event.type) {
      case 'quota-ask':
        this.deps.throttle?.ask(this.clientId(workerIndex));
        break;
      case 'progress': {
        const piece = this.task.pieces[event.pieceIndex];
        if (piece) piece.received += event.bytes;
        this.task.received = totalReceived(this.task.pieces);
        const now = Date.now();
        this.samples.push({ at: now, bytes: event.bytes });
        this.pace?.noteBytes(event.bytes, now);
        this.noteLeaseBytes(workerIndex, event.bytes, now);
        this.events.onCheckpoint?.(this.task);
        break;
      }
      case 'done': {
        const piece = this.task.pieces[event.pieceIndex];
        if (piece) {
          piece.state = 'done';
          // Chốt lại theo khoảng đã yêu cầu, phòng khi vài gói tiến độ bị mất.
          piece.received = piece.end - piece.start + 1;
        }
        this.task.received = totalReceived(this.task.pieces);
        this.assignment.delete(workerIndex);
        this.closeLease(workerIndex, 'done');
        this.events.onCheckpoint?.(this.task);
        this.pump();
        break;
      }
      case 'failed': {
        const piece = this.task.pieces[event.pieceIndex];
        this.assignment.delete(workerIndex);
        const status = event.status ?? null;
        this.notePressure(status, event.retryAfterMs ?? null);
        this.closeLease(workerIndex, 'failed', status, event.message);
        if (!piece) break;

        // Server đòi đúng nguồn dẫn: leo một bậc phát lại header rồi thử lại,
        // thay vì tuyên bố hỏng một lượt tải mà chỉ thiếu mỗi Referer.
        if (status !== null && DENIED_STATUSES.has(status) && this.escalate(status)) {
          piece.state = 'pending';
          break;
        }

        if (!event.retryable) {
          piece.state = 'failed';
          void this.fail(`Piece ${piece.index}: ${event.message}`);
          return;
        }
        if (!requeue(piece, this.options.maxRetries)) {
          void this.fail(`Piece ${piece.index} thất bại sau ${piece.attempts} lần: ${event.message}`);
          return;
        }
        warn('job', `piece ${piece.index} thử lại (${piece.attempts}): ${event.message}`);
        this.pump();
        break;
      }
      case 'aborted':
        this.assignment.delete(workerIndex);
        this.closeLease(workerIndex, 'abort');
        break;
    }
  }

  /**
   * Leo bậc phát lại header và cài lại luật.
   *
   * Trả false khi đã hết bậc hoặc không có gì để phát lại; khi đó lỗi được xử lý
   * như mọi lỗi khác. Việc cài luật là bất đồng bộ nên piece chỉ quay về hàng chờ,
   * `pump()` được gọi lại sau khi luật đã vào.
   */
  private escalate(status: number): boolean {
    const port = this.deps.headers;
    if (!port || !port.has(this.task.url)) return false;
    const next = nextTier(this.tier, status, true);
    if (next === null) return false;

    this.tier = next;
    log('job', `server trả ${status}, thử lại với header bậc ${next}`);
    void this.armHeaders().then(() => this.pump());
    return true;
  }

  private notePressure(status: number | null, retryAfterMs: number | null): void {
    if (!this.pace) return;
    const now = Date.now();
    if (status !== null) {
      this.pace.noteStatus(status, now, retryAfterMs);
      if (pressureFromStatus(status)) return;
    }
    this.pace.noteFailure('reset', now);
  }

  /* ---------- Nguồn dự phòng ---------- */

  private noteLeaseBytes(workerIndex: number, bytes: number, now: number): void {
    const lease = this.leases.get(workerIndex);
    if (!lease || !this.mirrors) return;
    this.mirrors.noteBytes(lease.mirrorId, bytes, Math.max(1, now - lease.lastAt));
    lease.lastAt = now;
    lease.bytes += bytes;
  }

  private closeLease(
    workerIndex: number,
    outcome: 'done' | 'failed' | 'abort',
    status: number | null = null,
    message = '',
  ): void {
    const lease = this.leases.get(workerIndex);
    if (!lease) return;
    this.leases.delete(workerIndex);
    if (!this.mirrors) return;

    const elapsed = Math.max(1, Date.now() - lease.startedAt);
    if (outcome === 'done') this.mirrors.notePieceDone(lease.mirrorId, lease.bytes, elapsed);
    else if (outcome === 'failed') {
      this.mirrors.noteFailure(lease.mirrorId, failureKind(status, message));
    }
    this.mirrors.release(lease.mirrorId);
  }

  private releaseAllLeases(): void {
    for (const index of [...this.leases.keys()]) this.closeLease(index, 'abort');
  }

  /* ---------- Đường tải khi không biết kích thước ---------- */

  /**
   * Server giấu Content-Length thì không chia được khoảng byte, nhưng từ chối
   * hẳn cũng vô lý: rất nhiều endpoint sinh file động vẫn tải được bình thường
   * bằng một kết nối biết tự nối lại chỗ đứt.
   */
  private async runStream(): Promise<void> {
    await this.openWriter(0);
    const channel = new MessageChannel();
    this.writer?.postMessage({ type: 'attach' } satisfies WriterCommand, [channel.port1]);
    const sink = createPortSink(channel.port2, this.options.writeHighWaterMark);
    this.streamSink = sink;

    this.stream = new StreamDownload(
      {
        url: this.task.finalUrl,
        headers: this.replayHeaders,
        etag: this.task.etag,
        lastModified: this.task.lastModified,
      },
      sink,
      {},
      {
        onProgress: (bytes) => {
          this.task.received += bytes;
          this.samples.push({ at: Date.now(), bytes });
        },
        onInfo: (info) => {
          this.task.finalUrl = info.finalUrl;
          if (info.filename) this.task.filename = info.filename;
          if (info.mimeType) this.task.mimeType = info.mimeType;
          if (info.totalSize !== null) this.task.size = info.totalSize;
        },
        onNotice: (message) => log('stream', message),
      },
    );

    this.setState('downloading');
    this.startProgressTicker();
    log('job', `tải một luồng: ${this.task.url}`);

    const outcome = await this.stream.run();
    if (outcome.ending === 'aborted') return;
    if (!outcome.completed) {
      await this.fail(outcome.error ?? 'Luồng đứt trước khi tới cuối file');
      return;
    }

    this.task.size = outcome.totalBytes;
    this.finished = true;
    await this.finalize();
  }

  private releaseAssignment(workerIndex: number, retry: boolean): void {
    const pieceIndex = this.assignment.get(workerIndex);
    if (pieceIndex === undefined) return;
    const piece = this.task.pieces[pieceIndex];
    if (piece && retry) piece.state = 'pending';
    this.assignment.delete(workerIndex);
    this.closeLease(workerIndex, 'abort');
  }

  /* ---------- Kết thúc ---------- */

  private maybeFinish(): void {
    if (this.finished || this.assignment.size > 0) return;
    if (!isComplete(this.task.pieces)) return;
    this.finished = true;
    void this.finalize();
  }

  private async finalize(): Promise<void> {
    this.stopProgressTicker();
    this.setState('assembling');

    try {
      this.streamSink?.dispose();
      await this.closeWriter();

      const written = await storage.partSize(this.task.id);
      if (this.task.size !== null && written !== this.task.size) {
        throw new Error(
          `Kích thước không khớp: nhận ${written} byte, cần ${this.task.size} byte`,
        );
      }

      const blobUrl = await storage.partAsBlobUrl(this.task.id, this.task.mimeType);
      this.setState('completed');
      this.events.onCheckpoint?.(this.task);
      this.events.onComplete?.({
        blobUrl,
        filename: this.task.filename,
        size: written,
        mimeType: this.task.mimeType,
      });
    } catch (err) {
      await this.fail(err instanceof Error ? err.message : String(err));
    } finally {
      this.terminateFetchers();
      this.detachAll();
    }
  }

  private closeWriter(): Promise<void> {
    const worker = this.writer;
    if (!worker) return Promise.resolve();

    return new Promise((resolve) => {
      const done = () => {
        worker.terminate();
        this.writer = null;
        resolve();
      };
      worker.onmessage = (event: MessageEvent<WriterEvent>) => {
        if (event.data.type === 'closed' || event.data.type === 'error') done();
      };
      worker.postMessage({ type: 'close' } satisfies WriterCommand);
      // Đừng để việc đóng file treo cả tiến trình nếu worker mất phản hồi.
      setTimeout(done, 5000);
    });
  }

  /** Buộc writer xả đệm xuống đĩa; persistence gọi trước mỗi lần chốt sổ. */
  flushWriter(): Promise<void> {
    const worker = this.writer;
    if (!worker) return Promise.resolve();

    return new Promise((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        // Trả lại trình xử lý thường trực, nếu không lỗi ghi sau này sẽ rơi vào hư không.
        worker.onmessage = (event: MessageEvent<WriterEvent>) => {
          if (event.data.type === 'error') void this.fail(`Lỗi ghi file tạm: ${event.data.message}`);
        };
        resolve();
      };
      worker.onmessage = (event: MessageEvent<WriterEvent>) => {
        if (event.data.type === 'flushed' || event.data.type === 'error') finish();
      };
      worker.postMessage({ type: 'flush' } satisfies WriterCommand);
      setTimeout(finish, 5000);
    });
  }

  private async fail(message: string): Promise<void> {
    if (this.task.state === 'failed' || this.task.state === 'canceled') return;
    this.finished = true;
    this.stopProgressTicker();
    this.abortFetchers();
    await this.teardown();
    await storage.removePart(this.task.id);

    // Lượt tải tự động thất bại không được phép trở thành file bị mất: giao lại
    // cho trình duyệt và im lặng. Lượt do người dùng tự thêm thì báo lỗi thật,
    // vì họ chủ động yêu cầu và cần biết chuyện gì xảy ra.
    if (this.task.source === 'auto') {
      this.setState('canceled');
      log('job', `engine hỏng, trả lại cho trình duyệt: ${message}`);
      this.events.onHandBack?.(message);
      return;
    }

    this.task.error = message;
    this.setState('failed', message);
    this.events.onCheckpoint?.(this.task);
  }

  private abortFetchers(): void {
    for (const worker of this.fetchers) {
      worker.postMessage({ type: 'abort' } satisfies FetchCommand);
    }
  }

  private detachAll(): void {
    const port = this.deps.throttle;
    if (port) this.fetchers.forEach((_, i) => port.detach(this.clientId(i)));
    this.deps.headers?.disarm(this.task.id);
  }

  private terminateFetchers(): void {
    this.detachAll();
    for (const worker of this.fetchers) worker.terminate();
    this.fetchers = [];
    this.assignment.clear();
    this.releaseAllLeases();
  }

  private async teardown(): Promise<void> {
    this.streamSink?.dispose();
    this.streamSink = null;
    await this.closeWriter();
    this.terminateFetchers();
  }

  /* ---------- Tiến độ ---------- */

  private startProgressTicker(): void {
    this.stopProgressTicker();
    this.progressTimer = setInterval(() => this.emitProgress(), 500);
  }

  private stopProgressTicker(): void {
    if (this.progressTimer !== null) {
      clearInterval(this.progressTimer);
      this.progressTimer = null;
    }
  }

  private emitProgress(): void {
    const now = Date.now();
    this.samples = this.samples.filter((s) => now - s.at <= SPEED_WINDOW_MS);
    const bytes = this.samples.reduce((sum, s) => sum + s.bytes, 0);
    const span = this.samples.length
      ? Math.max(1, now - (this.samples[0]?.at ?? now))
      : SPEED_WINDOW_MS;
    this.task.speed = Math.round((bytes * 1000) / span);

    if (this.pace) {
      this.pace.noteActive(this.assignment.size, now);
      const decision = this.pace.tick(now);
      if (decision.kind === 'grow' || decision.kind === 'shrink') {
        log('pace', decision.note);
        this.pump();
      }
    }

    this.events.onProgress?.({
      id: this.task.id,
      received: this.task.received,
      size: this.task.size,
      speed: this.task.speed,
      state: this.task.state,
      activeConnections: this.assignment.size,
    });
  }

  private setState(state: DownloadState, error: string | null = null): void {
    this.task.state = state;
    this.events.onState?.(state, error);
  }
}

/**
 * Cấu hình bộ dò số kết nối cho một lượt tải.
 *
 * Mở thẳng ở trần người dùng đặt, KHÔNG khởi đầu khiêm tốn rồi leo dần. Bộ dò
 * nhích một bậc mỗi hai cửa sổ, tức khoảng 4 giây, nên đi từ 2 lên trần mất
 * thời gian tỷ lệ thuận với trần — dài hơn hẳn phần lớn lượt tải. Đo bằng
 * `npm run bench`: khởi đầu khiêm tốn làm chậm đi rõ so với mở thẳng. Người
 * dùng đã nói rõ trần họ muốn; leo dần tới đó là phớt lờ họ suốt nửa phút đầu.
 *
 * Chiều GIẢM mới là chiều đáng giữ: 429, 503 hay Retry-After vẫn kéo số kết nối
 * xuống ngay lập tức, và `relaxCeiling` nới lại dần sau đó. Trần mặc định 64
 * cho bộ dò nhiều chỗ leo khi mạng tốt; bộ dò tự lùi khi server khó tính.
 *
 * Hàm thuần và xuất ra để bộ đo dùng đúng cấu hình này — chép lại nó ở chỗ khác
 * là cách chắc chắn để số đo nói về một thuật toán không ai chạy.
 */
export function paceOptionsFor(
  options: DownloadOptions,
  pieceCount: number,
): Partial<ConcurrencyOptions> {
  const max = Math.max(1, Math.min(options.connections, pieceCount || 1));
  return {
    min: Math.max(1, Math.min(options.minConnections, max)),
    max,
    start: max,
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}
