/**
 * Bền vững hóa tiến độ tải xuống `storage.local`.
 *
 * Dữ liệu đã tải nằm trong OPFS và sống sót qua việc đóng trình duyệt, nhưng bản
 * đồ "piece nào đã xong tới đâu" thì chỉ nằm trong RAM của engine — mất nó là mất
 * luôn khả năng nối tiếp, dù từng byte vẫn còn trên đĩa. Module này chép bản đồ
 * đó xuống đĩa theo nhịp.
 *
 * Hai điều định hình toàn bộ thiết kế:
 *
 * 1. Bản ghi phải là CẬN DƯỚI của dữ liệu thật sự đã nằm trên đĩa. Ghi thiếu chỉ
 *    tốn vài MiB tải lại; ghi thừa tạo ra một lỗ toàn số 0 giữa file và giao cho
 *    người dùng một file hỏng mà họ không hề biết. Vì vậy thứ tự luôn là: chụp
 *    ảnh vector piece TRƯỚC, ép writer xả đệm, rồi mới ghi bản ghi.
 * 2. Module này không được phép import `platform/api`. Offscreen document của
 *    Chromium chỉ chắc chắn dùng được `chrome.runtime`, nên nơi lưu trữ được tiêm
 *    vào qua cổng `PersistenceStore`: Firefox nối thẳng `storage.local`, Chromium
 *    nối qua HostBridge. Gọi thẳng `api.storage` sẽ chạy tốt trên Firefox và chết
 *    lặng trên Chromium.
 */

import { sanitize } from './filename';
import type { DownloadTask, Piece, TaskSource } from './types';

export const SCHEMA_VERSION = 1;
export const RECORD_PREFIX = 'df:task:';

/**
 * Trần số piece cho một bản ghi. Không phải giới hạn kỹ thuật mà là chốt chặn
 * trước dữ liệu vô lý: 100k piece ở kích thước tối đa 16 MiB đã là 1,5 TB.
 */
const MAX_PIECE_COUNT = 100_000;
const MAX_ID_LENGTH = 128;
const MAX_VALIDATOR_LENGTH = 512;
const MAX_MIME_LENGTH = 255;

// Dựng bằng RegExp constructor để không nhúng ký tự điều khiển thật vào mã nguồn.
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001F\\u007F]');

/* ---------- Hình dạng bản ghi ---------- */

export interface PersistedPieceMap {
  /** Kích thước piece đồng đều. 0 nghĩa là bố cục không đều, xem `starts`. */
  pieceSize: number;
  count: number;
  /** Chỉ có mặt khi các piece không đều nhau (chia piece động về sau). */
  starts?: number[];
  /** Số byte chắc chắn đã ghi của từng piece, cùng thứ tự index. */
  received: number[];
}

export interface PersistedTask {
  version: number;
  id: string;
  source: TaskSource;
  /** URL gốc người dùng yêu cầu — dùng để thăm dò lại, KHÔNG dùng finalUrl. */
  url: string;
  finalUrl: string;
  filename: string;
  mimeType: string | null;
  size: number;
  acceptRanges: boolean;
  etag: string | null;
  lastModified: string | null;
  /** Chỉ lưu hai trạng thái này; mọi trạng thái khác nghĩa là xóa hoặc bỏ qua. */
  state: 'downloading' | 'paused';
  received: number;
  pieces: PersistedPieceMap;
  createdAt: number;
  updatedAt: number;
}

/**
 * DownloadTask hiện chưa mang `mimeType` (nó là field private của DownloadJob).
 * Kiểu giao nhau này cho phép module chạy được cả trước lẫn sau khi types.ts
 * được bổ sung trường đó.
 */
export type PersistableTask = DownloadTask & { mimeType?: string | null };

/** Đủ để dựng lại một DownloadJob đang dở mà không cần chia piece lại. */
export interface ResumeSeed {
  id: string;
  source: TaskSource;
  createdAt: number;
  url: string;
  finalUrl: string;
  filename: string;
  mimeType: string | null;
  size: number;
  acceptRanges: boolean;
  etag: string | null;
  lastModified: string | null;
  pieces: Piece[];
  received: number;
}

/* ---------- Cổng lưu trữ ---------- */

/** Chromium nối qua HostBridge, Firefox nối thẳng `storage.local`. */
export interface PersistenceStore {
  read(prefix: string): Promise<Record<string, unknown>>;
  write(entries: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

/**
 * Bọc một StorageArea kiểu `chrome.storage.local`. Nhận tham số theo hình dạng
 * thay vì theo kiểu của chrome để file này không phải import platform/api.
 */
export function storeFromArea(area: {
  get(keys: null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}): PersistenceStore {
  return {
    async read(prefix: string): Promise<Record<string, unknown>> {
      const all = await area.get(null);
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(all ?? {})) {
        if (key.startsWith(prefix)) out[key] = value;
      }
      return out;
    },
    async write(entries: Record<string, unknown>): Promise<void> {
      if (Object.keys(entries).length === 0) return;
      await area.set(entries);
    },
    async remove(keys: string[]): Promise<void> {
      if (keys.length === 0) return;
      await area.remove(keys);
    },
  };
}

/* ---------- Tùy chọn ---------- */

export interface PersistenceOptions {
  intervalMs: number;
  bytesThreshold: number;
  maxRecords: number;
  maxAgeMs: number;
  maxRecordBytes: number;
  /** Hạn chờ writer xả đệm. Quá hạn thì hoãn ghi chứ không chờ tiếp. */
  barrierTimeoutMs: number;
}

/**
 * Hai điều kiện chốt sổ song song là cố ý. Chỉ hẹn giờ thì đường 1 Gbps mất tới
 * nửa GB tiến độ mỗi nhịp; chỉ đếm byte thì đường chậm cả tiếng không ghi lần nào.
 *
 * Nói rõ một chỗ dễ hiểu nhầm: các hạn ngạch MAX_WRITE_OPERATIONS_PER_HOUR là của
 * `storage.sync`, `storage.local` KHÔNG bị chặn tần suất. Ta tiết chế vì mỗi lần
 * ghi là một giao dịch leveldb trên luồng lưu trữ của trình duyệt, chứ không phải
 * vì sợ vượt hạn ngạch.
 */
export const DEFAULT_PERSISTENCE_OPTIONS: PersistenceOptions = {
  intervalMs: 4000,
  bytesThreshold: 32 * 1024 * 1024,
  maxRecords: 50,
  maxAgeMs: 7 * 24 * 60 * 60 * 1000,
  maxRecordBytes: 256 * 1024,
  // Cùng con số mà `closeWriter()` bên orchestrator đang dùng, và vì cùng một lý
  // do: worker mất phản hồi không được phép treo cả tiến trình.
  barrierTimeoutMs: 5000,
};

export interface PersistenceHooks {
  now?: () => number;
  /** Hẹn giờ tiêm được, để test chạy tất định. Trả về hàm hủy. */
  schedule?: (fn: () => void, ms: number) => () => void;
  /**
   * Bắt writer worker xả đệm xuống đĩa trước khi chốt sổ.
   *
   * Chỉ tùy chọn về mặt kiểu, KHÔNG tùy chọn khi chạy thật. `piece.received` đếm
   * byte đã post sang writer chứ không phải byte đã ghi, và mỗi fetch worker được
   * phép giữ tới `writeHighWaterMark` (mặc định 8 MiB) byte chưa ghi. Thiếu barrier
   * thì biên lùi 1 MiB của recovery.ts không đủ bù, và hậu quả là file hỏng lặng lẽ.
   * Chỉ được bỏ trống trong test.
   */
  barrier?: (taskIds: string[]) => Promise<void>;
  onError?: (err: unknown) => void;
}

/* ---------- Hàm thuần ---------- */

export function recordKey(id: string): string {
  return `${RECORD_PREFIX}${id}`;
}

/** null nghĩa là khóa này của tính năng khác — `settings` chẳng hạn — đừng đụng vào. */
export function taskIdFromKey(key: string): string | null {
  if (!key.startsWith(RECORD_PREFIX)) return null;
  const id = key.slice(RECORD_PREFIX.length);
  if (!id || id.length > MAX_ID_LENGTH || CONTROL_CHARS.test(id)) return null;
  return id;
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function normalizeHeaderValue(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max || CONTROL_CHARS.test(trimmed)) return null;
  return trimmed;
}

function readTime(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

export function sumReceived(pieces: readonly Piece[]): number {
  let sum = 0;
  for (const p of pieces) sum += p.received;
  return sum;
}

/**
 * Nén mảng Piece thành bản đồ tiến độ.
 *
 * `planPieces()` sinh piece đều nhau trừ piece cuối, nên toàn bộ bố cục tái tạo
 * được từ `size` + `pieceSize`: một file 4 GB tốn 256 con số thay vì 256 đối tượng
 * JSON. Nhánh `starts` giữ lại cho chia piece động về sau.
 *
 * `state` và `attempts` cố tình không được lưu: phiên mới xứng đáng có lại đủ lượt
 * thử, mang `attempts` cũ sang chỉ khiến một sự cố mạng tuần trước làm hỏng lượt
 * tải tuần này.
 */
export function encodePieces(pieces: readonly Piece[]): PersistedPieceMap | null {
  const count = pieces.length;
  if (count === 0 || count > MAX_PIECE_COUNT) return null;

  const received: number[] = [];
  const starts: number[] = [];
  let expectedStart = 0;

  for (let i = 0; i < count; i++) {
    const piece = pieces[i];
    if (!piece) return null;
    // Bản đồ chỉ có nghĩa khi các piece phủ kín file theo đúng thứ tự; hở hoặc
    // chồng lấn thì mọi phép tính offset về sau đều sai, thà không lưu còn hơn.
    if (piece.start !== expectedStart || piece.end < piece.start) return null;

    const length = piece.end - piece.start + 1;
    const got = Number.isFinite(piece.received) ? Math.floor(piece.received) : 0;
    received.push(Math.max(0, Math.min(length, got)));
    starts.push(piece.start);
    expectedStart = piece.end + 1;
  }

  const first = pieces[0];
  const last = pieces[count - 1];
  if (!first || !last) return null;

  const uniform = first.end - first.start + 1;
  let even = last.end - last.start + 1 <= uniform;
  for (let i = 0; even && i + 1 < count; i++) {
    const piece = pieces[i];
    if (!piece || piece.end - piece.start + 1 !== uniform) even = false;
  }

  return even
    ? { pieceSize: uniform, count, received }
    : { pieceSize: 0, count, starts, received };
}

/**
 * Dựng lại mảng Piece từ bản đồ. Trả về null với mọi bản đồ không tự nhất quán —
 * bản ghi đến từ đĩa nên phải coi là chưa tin được, kể cả khi kiểu tĩnh nói khác.
 */
export function decodePieces(map: PersistedPieceMap, size: number): Piece[] | null {
  if (!Number.isSafeInteger(size) || size <= 0) return null;

  const raw = map as unknown as Record<string, unknown> | null | undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const count = raw['count'];
  if (typeof count !== 'number' || !Number.isSafeInteger(count)) return null;
  if (count <= 0 || count > MAX_PIECE_COUNT) return null;

  const received = raw['received'];
  if (!Array.isArray(received) || received.length !== count) return null;

  const starts: number[] = [];
  const rawStarts = raw['starts'];

  if (rawStarts !== undefined && rawStarts !== null) {
    if (!Array.isArray(rawStarts) || rawStarts.length !== count) return null;
    let prev = -1;
    for (let i = 0; i < count; i++) {
      const value: unknown = rawStarts[i];
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) return null;
      if (value <= prev || value >= size) return null;
      starts.push(value);
      prev = value;
    }
    if (starts[0] !== 0) return null;
  } else {
    const pieceSize = raw['pieceSize'];
    if (typeof pieceSize !== 'number' || !Number.isSafeInteger(pieceSize) || pieceSize <= 0) {
      return null;
    }
    // Bố cục đều phải khớp chính xác với kích thước file, nếu không thì bản ghi
    // này thuộc về một file khác.
    if (Math.ceil(size / pieceSize) !== count) return null;
    for (let i = 0; i < count; i++) starts.push(i * pieceSize);
  }

  const pieces: Piece[] = [];
  for (let i = 0; i < count; i++) {
    const start = starts[i];
    if (start === undefined) return null;
    const next = i + 1 < count ? starts[i + 1] : size;
    if (next === undefined) return null;
    const end = next - 1;
    const length = end - start + 1;
    if (length <= 0) return null;

    const got: unknown = received[i];
    if (typeof got !== 'number' || !Number.isSafeInteger(got)) return null;
    // Kẹp im lặng sẽ biến một bản ghi hỏng thành một lượt tải hỏng; loại thẳng.
    if (got < 0 || got > length) return null;

    pieces.push({
      index: i,
      start,
      end,
      received: got,
      state: got === length ? 'done' : 'pending',
      attempts: 0,
    });
  }
  return pieces;
}

export type PersistDecision = 'store' | 'forget' | 'skip';

/**
 * `skip` dành cho các trạng thái quá độ (queued/probing/assembling): chúng không
 * mang tiến độ mới nào nhưng cũng không được phép xóa bản ghi cũ. Nhờ vậy nếu
 * trình duyệt chết đúng lúc đang ghép file, bản ghi "mọi piece đã xong" vẫn còn
 * và phiên sau đi thẳng tới bước ghép.
 */
export function persistDecision(
  task: Pick<PersistableTask, 'state' | 'size' | 'pieces'>,
): PersistDecision {
  switch (task.state) {
    case 'downloading':
    case 'paused':
      return task.size !== null && task.pieces.length > 0 ? 'store' : 'skip';
    case 'completed':
    case 'failed':
    case 'canceled':
      return 'forget';
    default:
      return 'skip';
  }
}

export function encodeTask(task: PersistableTask, now: number): PersistedTask | null {
  if (persistDecision(task) !== 'store') return null;

  const size = task.size;
  if (size === null || !Number.isSafeInteger(size) || size <= 0) return null;
  if (!isHttpUrl(task.url)) return null;

  const pieces = encodePieces(task.pieces);
  if (!pieces) return null;

  // Tổng suy từ bản đồ piece chứ không lấy `task.received`: hai con số có thể lệch
  // nhau trong chốc lát, và bản ghi buộc phải là cận dưới.
  let received = 0;
  for (const n of pieces.received) received += n;

  const createdAt = readTime(task.createdAt);

  return {
    version: SCHEMA_VERSION,
    id: task.id,
    source: task.source === 'auto' ? 'auto' : 'manual',
    url: task.url,
    finalUrl: isHttpUrl(task.finalUrl) ? task.finalUrl : task.url,
    filename: sanitize(task.filename),
    mimeType: normalizeHeaderValue(task.mimeType ?? null, MAX_MIME_LENGTH),
    size,
    acceptRanges: task.acceptRanges === true,
    etag: normalizeHeaderValue(task.etag, MAX_VALIDATOR_LENGTH),
    lastModified: normalizeHeaderValue(task.lastModified, MAX_VALIDATOR_LENGTH),
    state: task.state === 'paused' ? 'paused' : 'downloading',
    received,
    pieces,
    createdAt: createdAt ?? now,
    updatedAt: now,
  };
}

/**
 * Đọc một bản ghi thô. `storage.local` là biên tin cậy: bản ghi sống qua cả lần
 * nâng cấp extension, có thể do phiên bản khác ghi ra, và về nguyên tắc người dùng
 * sửa được hồ sơ trình duyệt. Một bản ghi mang `url: "file:///etc/passwd"` hay
 * `filename: "../../autostart.desktop"` sẽ khiến engine tự đi đọc file cục bộ hoặc
 * ghi ra ngoài thư mục tải, nên mọi trường đều bị soi lại từ đầu.
 */
export function decodeRecord(raw: unknown): PersistedTask | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;

  if (r['version'] !== SCHEMA_VERSION) return null;

  const id = r['id'];
  if (typeof id !== 'string' || !id || id.length > MAX_ID_LENGTH || CONTROL_CHARS.test(id)) {
    return null;
  }

  const source = r['source'];
  if (source !== 'manual' && source !== 'auto') return null;

  const url = r['url'];
  if (!isHttpUrl(url)) return null;

  const rawFinal = r['finalUrl'];
  // finalUrl của phiên trước thường là URL ký hạn đã chết; nó chỉ để tham khảo,
  // không đáng để loại cả bản ghi nếu hỏng.
  const finalUrl = isHttpUrl(rawFinal) ? rawFinal : url;

  const rawFilename = r['filename'];
  if (typeof rawFilename !== 'string' || !rawFilename) return null;

  const size = r['size'];
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) return null;

  const state = r['state'];
  if (state !== 'downloading' && state !== 'paused') return null;

  const acceptRanges = r['acceptRanges'];
  if (typeof acceptRanges !== 'boolean') return null;

  const createdAt = readTime(r['createdAt']);
  const updatedAt = readTime(r['updatedAt']);
  if (createdAt === null || updatedAt === null) return null;

  // Đi qua decode rồi encode lại để bản đồ vừa được kiểm tra vừa được chuẩn hóa.
  const decoded = decodePieces(r['pieces'] as PersistedPieceMap, size);
  if (!decoded) return null;
  const pieces = encodePieces(decoded);
  if (!pieces) return null;

  let received = 0;
  for (const n of pieces.received) received += n;

  return {
    version: SCHEMA_VERSION,
    id,
    source,
    url,
    finalUrl,
    filename: sanitize(rawFilename),
    mimeType: normalizeHeaderValue(r['mimeType'], MAX_MIME_LENGTH),
    size,
    acceptRanges,
    etag: normalizeHeaderValue(r['etag'], MAX_VALIDATOR_LENGTH),
    lastModified: normalizeHeaderValue(r['lastModified'], MAX_VALIDATOR_LENGTH),
    state,
    received,
    pieces,
    createdAt,
    updatedAt,
  };
}

/**
 * Điểm vào duy nhất khi đọc bản ghi từ đĩa.
 *
 * Bản ghi mang version mới hơn bị từ chối chứ không đọc bừa: phiên bản sau có thể
 * đổi ý nghĩa của chính những trường ta đang đọc, và hiểu sai bản đồ piece nghĩa
 * là giao file hỏng. Mất khả năng khôi phục khi người dùng hạ cấp extension là cái
 * giá rẻ hơn nhiều.
 */
export function migrateRecord(raw: unknown): PersistedTask | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const version = (raw as Record<string, unknown>)['version'];
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version <= 0) return null;

  if (version > SCHEMA_VERSION) return null;
  if (version < SCHEMA_VERSION) {
    // Chưa có schema cũ nào cần nâng cấp. Khi thêm SCHEMA_VERSION 2, chỗ này là
    // nơi chuyển hình dạng v1 sang v2 rồi mới gọi decodeRecord.
    return null;
  }
  return decodeRecord(raw);
}

/**
 * Chọn bản ghi đáng giữ. Quá hạn thì bỏ vì file tạm tương ứng gần như chắc chắn
 * đã bị dọn; vượt hạn mức thì giữ những bản mới nhất, vì đó là thứ người dùng còn
 * nhớ mình đang tải.
 */
export function selectStale(
  records: readonly PersistedTask[],
  now: number,
  options: Pick<PersistenceOptions, 'maxRecords' | 'maxAgeMs'>,
): { keep: PersistedTask[]; drop: PersistedTask[] } {
  const keep: PersistedTask[] = [];
  const drop: PersistedTask[] = [];

  const newestFirst = [...records].sort((a, b) => b.updatedAt - a.updatedAt);
  for (const record of newestFirst) {
    const tooOld = now - record.updatedAt > options.maxAgeMs;
    if (tooOld || keep.length >= options.maxRecords) drop.push(record);
    else keep.push(record);
  }
  return { keep, drop };
}

export interface LoadResult {
  records: PersistedTask[];
  /** id của bản ghi vừa bị dọn; caller nên xóa .part tương ứng. */
  removedIds: string[];
}

/**
 * Ước lượng kích thước bản ghi thay vì `JSON.stringify().length`.
 *
 * Chuỗi hóa cả bản ghi mỗi 4 giây chỉ để đo độ dài là lãng phí; con số dưới đây
 * chỉ cần đủ chính xác để chặn trường hợp vô lý, không cần đúng từng byte.
 */
function estimateBytes(record: PersistedTask): number {
  const perPiece = record.pieces.starts ? 24 : 12;
  return (
    300 +
    record.url.length +
    record.finalUrl.length +
    record.filename.length +
    record.pieces.count * perPiece
  );
}

interface Tracked {
  task: PersistableTask;
  dirty: boolean;
  lastWriteAt: number;
  lastWriteReceived: number;
}

/**
 * Điều tiết nhịp ghi và giữ cho các lần ghi nối tiếp nhau.
 *
 * Nối tiếp là bắt buộc chứ không phải cho gọn: `planRecovery()` lúc khởi động và
 * một `checkpoint()` từ task người dùng vừa thêm hoàn toàn có thể chạy chồng lên
 * nhau, và hai lượt ghi song song có thể làm mất bản ghi vừa tạo.
 */
export class TaskPersistence {
  private readonly options: PersistenceOptions;
  private readonly hooks: PersistenceHooks;
  private readonly tracked = new Map<string, Tracked>();
  private cancelTimer: (() => void) | null = null;
  private chain: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(
    private readonly store: PersistenceStore,
    options: Partial<PersistenceOptions> = {},
    hooks: PersistenceHooks = {},
  ) {
    this.options = { ...DEFAULT_PERSISTENCE_OPTIONS, ...options };
    this.hooks = hooks;
  }

  /** Đánh dấu có thay đổi; ghi thật theo nhịp. Gọi thoải mái, kể cả mỗi 500ms. */
  touch(task: PersistableTask): void {
    if (this.disposed) return;

    const decision = persistDecision(task);
    if (decision === 'forget') {
      void this.forget(task.id);
      return;
    }
    if (decision === 'skip') return;

    const existing = this.tracked.get(task.id);
    if (!existing) {
      // Task mới: ghi ngay để bản ghi tồn tại sớm nhất có thể. Cửa sổ nguy hiểm
      // nhất là vài giây đầu, lúc chưa có gì trên đĩa để mà khôi phục.
      this.tracked.set(task.id, {
        task,
        dirty: true,
        lastWriteAt: 0,
        lastWriteReceived: 0,
      });
      this.requestFlush();
      return;
    }

    existing.task = task;
    existing.dirty = true;

    const dueByTime = this.now() - existing.lastWriteAt >= this.options.intervalMs;
    const dueByBytes =
      sumReceived(task.pieces) - existing.lastWriteReceived >= this.options.bytesThreshold;

    if (dueByTime || dueByBytes) this.requestFlush();
    else this.arm();
  }

  /** Ghi ngay lập tức, dùng cho chuyển trạng thái quan trọng (pause, bắt đầu tải). */
  async checkpoint(task: PersistableTask): Promise<void> {
    if (this.disposed) return;

    const decision = persistDecision(task);
    if (decision === 'forget') {
      await this.forget(task.id);
      return;
    }
    if (decision === 'skip') return;

    const existing = this.tracked.get(task.id);
    if (existing) {
      existing.task = task;
      existing.dirty = true;
    } else {
      this.tracked.set(task.id, { task, dirty: true, lastWriteAt: 0, lastWriteReceived: 0 });
    }
    await this.enqueue(() => this.writeDirty());
  }

  /** Xóa bản ghi khi task xong, bị hủy, hỏng, hoặc trả về cho trình duyệt. */
  async forget(id: string): Promise<void> {
    this.tracked.delete(id);
    await this.enqueue(async () => {
      await this.safe(() => this.store.remove([recordKey(id)]));
    });
  }

  /** Đọc mọi bản ghi hợp lệ, đồng thời dọn bản ghi hỏng/quá hạn/vượt hạn mức. */
  loadAll(): Promise<LoadResult> {
    return this.enqueue(() => this.readAll());
  }

  /** Ghi hết phần còn treo. Nỗ lực tốt nhất, không bảo đảm khi trình duyệt tắt. */
  async flushPending(): Promise<void> {
    if (this.disposed) return;
    this.clearTimer();
    await this.enqueue(() => this.writeDirty());
  }

  /**
   * Chờ mọi thao tác lưu trữ đang xếp hàng kết thúc, không kích hoạt lần ghi mới.
   * Dùng cho test và cho lúc tắt engine.
   */
  settled(): Promise<void> {
    return this.chain;
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    this.tracked.clear();
  }

  /* ---------- Bên trong ---------- */

  private now(): number {
    return this.hooks.now ? this.hooks.now() : Date.now();
  }

  private clearTimer(): void {
    if (this.cancelTimer) {
      this.cancelTimer();
      this.cancelTimer = null;
    }
  }

  /** Hẹn giờ dùng chung cho nhịp chốt sổ và hạn chờ barrier; trả về hàm hủy. */
  private setTimer(fn: () => void, ms: number): () => void {
    if (this.hooks.schedule) return this.hooks.schedule(fn, ms);
    const handle = setTimeout(fn, ms);
    return () => clearTimeout(handle);
  }

  /** Bộ hẹn giờ chỉ được lên dây khi có dữ liệu bẩn, và chỉ một cái cho cả instance. */
  private arm(): void {
    if (this.disposed || this.cancelTimer) return;
    const fire = (): void => {
      this.cancelTimer = null;
      this.requestFlush();
    };
    this.cancelTimer = this.setTimer(fire, this.options.intervalMs);
  }

  private requestFlush(): void {
    this.clearTimer();
    void this.enqueue(() => this.writeDirty());
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn);
    // Nuốt lỗi ở nhánh nối tiếp, nếu không một lần hỏng sẽ làm rớt mọi lần sau.
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private report(err: unknown): void {
    this.hooks.onError?.(err);
  }

  /**
   * Chờ writer xả đệm, nhưng không chờ vô hạn.
   *
   * Writer worker bị terminate giữa chừng thì lệnh `flush` không bao giờ được đáp,
   * và vì mọi thao tác lưu trữ đi chung một hàng nối tiếp, một lần treo sẽ khóa
   * cứng cả `flushPending()` lúc tắt engine. Trả về false nghĩa là KHÔNG chứng minh
   * được byte đã nằm trên đĩa.
   */
  private async runBarrier(ids: string[]): Promise<boolean> {
    const barrier = this.hooks.barrier;
    if (!barrier) return true;

    let cancel: () => void = () => {};
    const deadline = new Promise<'timeout'>((resolve) => {
      cancel = this.setTimer(() => resolve('timeout'), this.options.barrierTimeoutMs);
    });

    // Bắt lỗi ngay trên lời hứa của barrier chứ không để Promise.race lo: nếu hạn
    // chờ thắng trước rồi barrier mới ném, lỗi đó thành unhandled rejection.
    const flushed = barrier(ids).then(
      () => 'ok' as const,
      (err: unknown) => ({ err }),
    );

    const outcome = await Promise.race([flushed, deadline]);
    cancel();

    if (outcome === 'ok') return true;
    if (outcome === 'timeout') {
      this.report(
        new Error(`Writer không xả đệm trong ${this.options.barrierTimeoutMs}ms, hoãn ghi bản ghi`),
      );
      return false;
    }
    this.report(outcome.err);
    return false;
  }

  /**
   * Hoãn lần ghi này: bật lại cờ bẩn rồi hẹn giờ thử tiếp.
   *
   * Bản ghi cũ trên đĩa vẫn nằm nguyên, và nó đã qua một lần barrier thành công nên
   * vẫn là cận dưới đúng. Không có tiến độ nào bị mất, chỉ bị chốt sổ muộn hơn.
   */
  private retryLater(pending: ReadonlyArray<{ id: string }>): void {
    for (const item of pending) {
      const entry = this.tracked.get(item.id);
      if (entry) entry.dirty = true;
    }
    this.arm();
  }

  /** Trả về false khi thao tác hỏng; lỗi lưu trữ không bao giờ được ném ra ngoài. */
  private async safe(fn: () => Promise<void>): Promise<boolean> {
    try {
      await fn();
      return true;
    } catch (err) {
      this.report(err);
      return false;
    }
  }

  private async writeDirty(): Promise<void> {
    if (this.disposed) return;

    const now = this.now();
    const entries: Record<string, unknown> = {};
    const staleKeys: string[] = [];
    const written: Array<{ id: string; received: number }> = [];

    for (const [id, entry] of this.tracked) {
      if (!entry.dirty) continue;

      const decision = persistDecision(entry.task);
      if (decision === 'forget') {
        // Task kết thúc trong lúc chờ tới lượt ghi.
        this.tracked.delete(id);
        staleKeys.push(recordKey(id));
        continue;
      }
      if (decision === 'skip') {
        // Trạng thái quá độ (đang ghép file chẳng hạn): bỏ qua lần ghi này nhưng
        // tuyệt đối không xóa bản ghi cũ — nó chính là thứ cứu được lượt tải nếu
        // trình duyệt chết giữa lúc ghép.
        entry.dirty = false;
        continue;
      }

      // Chụp ảnh vector piece TRƯỚC khi gọi barrier. Ảnh chụp sau sẽ chứa những
      // byte vừa được post sang writer mà chưa chắc đã qua flush.
      const record = encodeTask(entry.task, now);
      entry.dirty = false;

      if (!record) continue;
      if (estimateBytes(record) > this.options.maxRecordBytes) {
        this.report(
          new Error(`Bản ghi khôi phục của ${id} vượt ${this.options.maxRecordBytes} byte, bỏ qua`),
        );
        // Lần sau cũng sẽ vượt. Ghi nhận như một lần chốt sổ để nhịp điều tiết giữ
        // lại, nếu không mỗi gói tiến độ sẽ kéo theo một lần encode và một lần báo lỗi.
        entry.lastWriteAt = now;
        entry.lastWriteReceived = record.received;
        continue;
      }

      entries[recordKey(id)] = record;
      written.push({ id, received: record.received });
    }

    if (staleKeys.length > 0) await this.safe(() => this.store.remove(staleKeys));
    if (written.length === 0) return;

    // Ảnh chụp đã xong; giờ mới ép writer xả đệm, để những byte trong ảnh chụp
    // chắc chắn nằm trên đĩa trước khi bản ghi tuyên bố là đã có. Barrier hỏng hay
    // quá hạn thì tuyệt đối không được ghi tiếp: bản ghi khi đó có thể nhận vơ những
    // byte còn nằm trong đệm, đúng cái làm ra file hỏng mà người dùng không biết.
    if (!(await this.runBarrier(written.map((w) => w.id)))) {
      this.retryLater(written);
      return;
    }

    const ok = await this.safe(() => this.store.write(entries));
    if (!ok) {
      // Ghi hỏng thì bật lại cờ bẩn để lần sau thử tiếp, chứ không mất tiến độ.
      this.retryLater(written);
      return;
    }

    for (const item of written) {
      const entry = this.tracked.get(item.id);
      if (!entry) continue;
      entry.lastWriteAt = now;
      entry.lastWriteReceived = item.received;
      // touch() trong lúc chờ ghi đã bật lại cờ bẩn; giữ nguyên và hẹn giờ tiếp.
      if (entry.dirty) this.arm();
    }
  }

  private async readAll(): Promise<LoadResult> {
    let raw: Record<string, unknown>;
    try {
      raw = await this.store.read(RECORD_PREFIX);
    } catch (err) {
      this.report(err);
      return { records: [], removedIds: [] };
    }

    const records: PersistedTask[] = [];
    const badKeys: string[] = [];
    const removedIds: string[] = [];

    for (const [key, value] of Object.entries(raw ?? {})) {
      const id = taskIdFromKey(key);
      if (id === null) continue; // Khóa của tính năng khác; không phải việc của ta.

      const record = migrateRecord(value);
      // Khóa và id bên trong phải khớp, nếu không thì bản ghi đã bị chép nhầm chỗ.
      if (!record || record.id !== id) {
        badKeys.push(key);
        removedIds.push(id);
        continue;
      }
      records.push(record);
    }

    const { keep, drop } = selectStale(records, this.now(), this.options);
    for (const record of drop) removedIds.push(record.id);

    const toRemove = [...badKeys, ...drop.map((r) => recordKey(r.id))];
    if (toRemove.length > 0) await this.safe(() => this.store.remove(toRemove));

    return { records: keep, removedIds };
  }
}
