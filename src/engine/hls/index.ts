/**
 * Điều phối tải một playlist HLS.
 *
 * Bề mặt công khai của `HlsJob` cố tình soi gương `DownloadJob` (`task`, `start`,
 * `pause`, `resume`, `cancel`, cùng `JobEvents`) để `DownloadManager` giữ được cả hai
 * loại job sau một interface chung mà không phải rẽ nhánh ở mọi chỗ.
 *
 * Điểm khác biệt lớn nhất so với engine tải file thường, và là lý do segment KHÔNG đi
 * qua `fetch-worker`: giao ước của fetch-worker là `(start, end)` → ghi vào một offset
 * tuyệt đối biết trước. Với HLS ta không biết độ dài segment trước khi tải xong, nên
 * không tính được offset. Tệ hơn, segment mã hóa AES-128-CBC bắt buộc phải có đủ cả
 * segment mới bóc được padding, nên ghi thẳng xuống đĩa theo dòng là bất khả thi về
 * nguyên tắc chứ không phải vì lười. Đổi lại, `writer-worker` vẫn được dùng lại nguyên
 * vẹn qua `SequentialPartWriter`, nên ràng buộc một writer độc quyền vẫn được tôn trọng.
 */

import {
  parsePlaylist,
  pickAudioRendition,
  pickVariant,
  PlaylistError,
  type KeyInfo,
  type MasterPlaylist,
  type MediaPlaylist,
  type QualityPreference,
  type Rendition,
  type Variant,
} from './playlist';
import {
  assertSupported,
  decryptSegment,
  ivForSegment,
  KeyStore,
  UnsupportedEncryptionError,
} from './keys';
import {
  getRemuxer,
  OrderedSink,
  planAssembly,
  SequentialPartWriter,
  type AssemblyPlan,
} from './assemble';
import { isComplete, requeue, takeNextPending, totalReceived } from '../pieces';
import * as storage from '../storage';
import { sanitize } from '../filename';
import type { DownloadState, DownloadTask, Piece, TaskSource } from '../types';
import type { JobEvents } from '../orchestrator';
import { log, warn } from '../../shared/log';

export interface HlsJobOptions {
  concurrency: number;
  maxRetries: number;
  maxBufferedBytes: number;
  quality: QualityPreference;
  /** `api.runtime.getURL('writer-worker.js')` — truyền vào để module này độc lập nền tảng. */
  writerWorkerUrl: string;
  /** Segment lớn bất thường thì hạ về một kết nối, nếu không trần đệm sẽ vỡ. */
  hugeSegmentBytes: number;
  /** Ghim sẵn tên file khi bên gọi đã quyết (ví dụ file tiếng đi kèm). */
  filename?: string;
  /** Đây là luồng audio-only tải kèm cho một video có tiếng tách rời. */
  audioOnly?: boolean;
}

export const DEFAULT_HLS_OPTIONS: Omit<
  HlsJobOptions,
  'writerWorkerUrl' | 'filename' | 'audioOnly'
> = {
  concurrency: 6,
  maxRetries: 5,
  maxBufferedBytes: 64 * 1024 * 1024,
  quality: 'best',
  hugeSegmentBytes: 128 * 1024 * 1024,
};

/** Sau ngần này segment mới dám ước lượng tổng dung lượng; ít hơn thì nhiễu quá. */
const ESTIMATE_AFTER = 8;
/** Số lần 401/403 liên tiếp trước khi nghi chữ ký URL đã hết hạn. */
const REFRESH_AFTER_DENIED = 3;
const SPEED_WINDOW_MS = 3000;

/* ---------- Nhận biết URL ---------- */

export type MediaUrlKind = 'hls' | 'dash' | 'unknown';

const HLS_PATTERN = /\.m3u8?(?![a-z0-9])/i;
const DASH_PATTERN = /\.mpd(?![a-z0-9])/i;

/**
 * Đoán từ URL, không gọi mạng. Xét cả query string vì rất nhiều CDN giấu tên
 * playlist ở đó (`/play?file=abc.m3u8&token=...`) thay vì ở phần đường dẫn.
 */
export function classifyMediaUrl(url: string): MediaUrlKind {
  let hay = url;
  try {
    const parsed = new URL(url);
    hay = `${parsed.pathname}${parsed.search}`;
  } catch {
    // URL tương đối hoặc rác: cứ soi nguyên chuỗi, tệ nhất là đoán sai.
  }

  let decoded = hay;
  try {
    decoded = decodeURIComponent(hay);
  } catch {
    // Chuỗi phần trăm hỏng thì dùng bản gốc.
  }

  if (HLS_PATTERN.test(decoded) || /mpegurl/i.test(decoded)) return 'hls';
  if (DASH_PATTERN.test(decoded) || /dash\+xml/i.test(decoded)) return 'dash';
  return 'unknown';
}

/* ---------- Tải và đọc playlist ---------- */

/**
 * Trần cứng cho một playlist. Kể cả phim bốn tiếng chia segment hai giây cũng chỉ ra
 * cỡ vài trăm KB văn bản, nên 8 MB là rộng rãi.
 *
 * Cần trần vì `probeMedia()` được gọi cho cả những URL mới chỉ NGHI là playlist — một
 * mục `.mp4` mà content script bắt được chẳng hạn. Không có trần thì `res.text()` kéo
 * nguyên bộ phim 4 GB vào RAM của offscreen document rồi giết cả engine, và người dùng
 * chỉ thấy popup đứng hình.
 */
const MAX_PLAYLIST_BYTES = 8 * 1024 * 1024;

/** Đọc theo dòng và bỏ cuộc ngay khi vượt trần, chứ không gom xong rồi mới đo. */
async function readCapped(res: Response, limit: number): Promise<string> {
  const body = res.body;
  if (!body) return res.text();

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let out = '';
  let total = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > limit) {
      void reader.cancel().catch(() => {});
      throw new Error(
        `Nội dung dài hơn ${Math.round(limit / 1048576)} MB nên chắc chắn không phải playlist M3U8`,
      );
    }
    out += decoder.decode(chunk.value, { stream: true });
  }
  return out + decoder.decode();
}

async function fetchText(url: string, signal?: AbortSignal): Promise<{ text: string; finalUrl: string }> {
  const res = await fetch(url, {
    method: 'GET',
    credentials: 'include',
    cache: 'no-store',
    redirect: 'follow',
    signal: signal ?? null,
  });
  if (!res.ok) throw new Error(`Không tải được playlist: HTTP ${res.status} ${res.statusText}`);

  // Loại thẳng thứ chắc chắn không phải văn bản playlist trước khi đọc byte nào.
  // Chú ý chừa `audio/mpegurl` và `audio/x-mpegurl` — đó là MIME thật của M3U8.
  const type = (res.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (/^(video|audio|image)\//.test(type) && !type.includes('mpegurl')) {
    void res.body?.cancel().catch(() => {});
    throw new Error(`Đường dẫn này trả về ${type} chứ không phải playlist M3U8`);
  }

  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_PLAYLIST_BYTES) {
    void res.body?.cancel().catch(() => {});
    throw new Error(
      `Nội dung khai dài ${Math.round(declared / 1048576)} MB, quá lớn để là một playlist M3U8`,
    );
  }

  return { text: await readCapped(res, MAX_PLAYLIST_BYTES), finalUrl: res.url || url };
}

/** Tên chung chung thì không nói lên điều gì; lấy tên miền còn dễ nhận ra hơn. */
const GENERIC_NAMES = new Set([
  'index',
  'master',
  'playlist',
  'stream',
  'manifest',
  'chunklist',
  'video',
  'main',
  'prog_index',
]);

function deriveFilename(playlistUrl: string, extension: string, hint?: string | null): string {
  let base = hint ?? '';

  if (!base) {
    try {
      const parsed = new URL(playlistUrl);
      const last = parsed.pathname.split('/').filter(Boolean).pop() ?? '';
      const stem = decodeURIComponent(last).replace(/\.(m3u8?|mpd)$/i, '');
      base = GENERIC_NAMES.has(stem.toLowerCase()) ? parsed.hostname : stem;
    } catch {
      base = 'video';
    }
  }

  const clean = sanitize(base).replace(/\.(m3u8?|mpd)$/i, '') || 'video';
  return clean.toLowerCase().endsWith(extension) ? clean : `${clean}${extension}`;
}

/* ---------- Thăm dò ---------- */

export interface VariantSummary {
  uri: string;
  /** Ví dụ '1920×1080 · 6,2 Mbps'. */
  label: string;
  bandwidth: number;
  height: number | null;
  hasSeparateAudio: boolean;
}

export interface MediaProbe {
  kind: 'hls-master' | 'hls-media' | 'dash' | 'not-media';
  url: string;
  filename: string;
  variants: VariantSummary[];
  duration: number | null;
  isLive: boolean;
  warnings: string[];
  blocker: string | null;
}

function mbps(bandwidth: number): string {
  return `${(bandwidth / 1_000_000).toFixed(1).replace('.', ',')} Mbps`;
}

function summarize(variant: Variant): VariantSummary {
  const res = variant.resolution;
  const size = res ? `${res.width}×${res.height}` : 'không rõ độ phân giải';
  return {
    uri: variant.uri,
    label: variant.bandwidth > 0 ? `${size} · ${mbps(variant.bandwidth)}` : size,
    bandwidth: variant.bandwidth,
    height: res?.height ?? null,
    hasSeparateAudio: variant.audioGroup !== null,
  };
}

/**
 * Xem một URL có tải được không, TRƯỚC khi người dùng bấm tải.
 *
 * Với master playlist thì tốn thêm một request để đọc luôn variant tốt nhất — đắt hơn
 * một chút nhưng đó là cách duy nhất biết được luồng là live hay VOD, và biết sớm mới
 * kịp nói cho người dùng thay vì để họ chờ rồi mới báo hỏng.
 */
export async function probeMedia(url: string, signal?: AbortSignal): Promise<MediaProbe> {
  const kind = classifyMediaUrl(url);

  const base: MediaProbe = {
    kind: 'not-media',
    url,
    filename: deriveFilename(url, '.bin'),
    variants: [],
    duration: null,
    isLive: false,
    warnings: [],
    blocker: null,
  };

  if (kind === 'dash') {
    return {
      ...base,
      kind: 'dash',
      filename: deriveFilename(url, '.mp4'),
      blocker:
        'Đây là luồng DASH (.mpd). Extension nhận ra nhưng chưa đọc được định dạng này — hiện chỉ hỗ trợ HLS (.m3u8).',
    };
  }

  let text: string;
  let finalUrl: string;
  try {
    ({ text, finalUrl } = await fetchText(url, signal));
  } catch (err) {
    return { ...base, blocker: err instanceof Error ? err.message : String(err) };
  }

  let parsed;
  try {
    parsed = parsePlaylist(text, finalUrl);
  } catch (err) {
    const message =
      err instanceof PlaylistError
        ? err.message
        : `Không đọc được playlist: ${err instanceof Error ? err.message : String(err)}`;
    return { ...base, blocker: message };
  }

  if (parsed.kind === 'media') {
    const plan = planAssembly(parsed, { separateAudio: false });
    return {
      kind: 'hls-media',
      url: finalUrl,
      filename: deriveFilename(finalUrl, plan.extension),
      variants: [],
      duration: parsed.totalDuration || null,
      isLive: parsed.isLive,
      warnings: plan.warnings,
      blocker: plan.blocker,
    };
  }

  const variants = parsed.variants.map(summarize).sort((a, b) => b.bandwidth - a.bandwidth);
  if (variants.length === 0) {
    return {
      ...base,
      kind: 'hls-master',
      url: finalUrl,
      blocker: 'Master playlist không liệt kê luồng nào tải được.',
    };
  }

  const chosen = pickVariant(parsed, 'best')!;
  try {
    const inner = await fetchText(chosen.uri, signal);
    const media = parsePlaylist(inner.text, inner.finalUrl);
    if (media.kind !== 'media') throw new PlaylistError('Variant lại trỏ tới một master playlist khác', 'not-m3u8');

    const audio = pickAudioRendition(parsed, chosen);
    const plan = planAssembly(media, { separateAudio: audio !== null });
    return {
      kind: 'hls-master',
      url: finalUrl,
      filename: deriveFilename(finalUrl, plan.extension),
      variants,
      duration: media.totalDuration || null,
      isLive: media.isLive,
      warnings: plan.warnings,
      blocker: plan.blocker,
    };
  } catch (err) {
    return {
      kind: 'hls-master',
      url: finalUrl,
      filename: deriveFilename(finalUrl, '.mp4'),
      variants,
      duration: null,
      isLive: false,
      warnings: [],
      blocker: `Không đọc được luồng con: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/* ---------- Giải nghĩa playlist ---------- */

export interface ResolvedStream {
  playlistUrl: string;
  master: MasterPlaylist | null;
  variant: Variant | null;
  media: MediaPlaylist;
  /** Khác null nghĩa là cần tải thêm một file tiếng riêng. */
  audio: Rendition | null;
  plan: AssemblyPlan;
  /** Đã qua sanitize(), đã có đuôi đúng. */
  filename: string;
}

export async function resolvePlaylist(
  url: string,
  pref: QualityPreference = 'best',
  signal?: AbortSignal,
  audioOnly = false,
): Promise<ResolvedStream> {
  const first = await fetchText(url, signal);
  const parsed = parsePlaylist(first.text, first.finalUrl);

  if (parsed.kind === 'media') {
    const plan = planAssembly(parsed, { separateAudio: false, audioOnly });
    return {
      playlistUrl: first.finalUrl,
      master: null,
      variant: null,
      media: parsed,
      audio: null,
      plan,
      filename: deriveFilename(first.finalUrl, plan.extension),
    };
  }

  const variant = pickVariant(parsed, pref);
  if (!variant) throw new PlaylistError('Master playlist không có luồng nào để tải', 'no-segments');

  const inner = await fetchText(variant.uri, signal);
  const media = parsePlaylist(inner.text, inner.finalUrl);
  if (media.kind !== 'media') {
    throw new PlaylistError('Variant trỏ tới một master playlist khác, không xử lý được', 'not-m3u8');
  }

  const audio = pickAudioRendition(parsed, variant);
  const plan = planAssembly(media, { separateAudio: audio !== null, audioOnly });

  return {
    playlistUrl: inner.finalUrl,
    master: parsed,
    variant,
    media,
    audio,
    plan,
    // Tên lấy theo URL master vì nó thường mang tên phim; URL variant hay là 'index'.
    filename: deriveFilename(first.finalUrl, plan.extension),
  };
}

/* ---------- Danh sách việc tải ---------- */

export interface SegmentRequest {
  index: number;
  url: string;
  /** Từ EXT-X-BYTERANGE; đã đổi sang cặp start/end inclusive của header Range. */
  range: { start: number; end: number } | null;
  key: KeyInfo | null;
  /** Đã dựng sẵn, kể cả IV mặc định từ số thứ tự media. */
  iv: Uint8Array | null;
  /** EXT-X-MAP, luôn đứng ở index 0. */
  isInit: boolean;
  /** EXT-X-GAP: server đã báo trước là đoạn này không có, đừng thử tải. */
  gap: boolean;
}

/**
 * Init segment (nếu có) được chèn thành phần tử đầu, nên thứ tự của mảng này CHÍNH LÀ
 * thứ tự ghi ra file. Nhờ vậy `OrderedSink` chỉ cần đếm 0,1,2,... mà không phải biết
 * gì về HLS.
 */
export function buildSegmentRequests(media: MediaPlaylist): SegmentRequest[] {
  const out: SegmentRequest[] = [];
  const first = media.segments[0];
  const map = first?.map ?? media.initSegments[0] ?? null;

  if (map) {
    out.push({
      index: 0,
      url: map.uri,
      range: map.byteRange
        ? { start: map.byteRange.offset, end: map.byteRange.offset + map.byteRange.length - 1 }
        : null,
      // Init section CÓ THỂ được mã hóa bằng khóa đang hiệu lực, nhưng nhiều packager
      // để nguyên. Mang khóa theo để job còn đường giải mã, còn quyết định có giải hay
      // không thì dựa vào việc dữ liệu tải về có phải box ftyp/styp hợp lệ hay không.
      key: first?.key ?? null,
      iv: first ? ivForSegment(first) : null,
      isInit: true,
      gap: false,
    });
  }

  for (const segment of media.segments) {
    out.push({
      index: out.length,
      url: segment.uri,
      range: segment.byteRange
        ? {
            start: segment.byteRange.offset,
            end: segment.byteRange.offset + segment.byteRange.length - 1,
          }
        : null,
      key: segment.key,
      iv: segment.key ? ivForSegment(segment) : null,
      isInit: false,
      gap: segment.gap,
    });
  }

  return out;
}

/* ---------- Lỗi có phân loại ---------- */

class SegmentError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly denied = false,
  ) {
    super(message);
    this.name = 'SegmentError';
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    // Gắn listener lên một signal đã abort thì nó không bao giờ kêu nữa. Bỏ qua ca này
    // nghĩa là runner nằm ngủ hết cả 30 giây chờ lũy thừa sau khi job đã bị hủy.
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    }
    signal?.addEventListener('abort', finish, { once: true });
  });
}

/** fMP4 hợp lệ mở đầu bằng box ftyp hoặc styp; moov đứng đầu cũng chấp nhận được. */
function looksLikeInitSegment(data: Uint8Array): boolean {
  if (data.length < 8) return false;
  const tag = String.fromCharCode(data[4]!, data[5]!, data[6]!, data[7]!);
  return tag === 'ftyp' || tag === 'styp' || tag === 'moov';
}

/* ---------- Job ---------- */

export class HlsJob {
  readonly task: DownloadTask;
  stream: ResolvedStream | null = null;
  /** Tên file phần tạm chứa kết quả cuối; khác `${id}.part` chỉ khi có remux. */
  outputPartName: string;

  private readonly options: HlsJobOptions;
  private readonly events: JobEvents;
  private readonly keys = new KeyStore();

  private requests: SegmentRequest[] = [];
  private writer: SequentialPartWriter | null = null;
  private sink: OrderedSink | null = null;
  private controller: AbortController | null = null;

  private stopping = false;
  private finished = false;
  private active = 0;
  /** Tăng mỗi lần phát lại đội runner, để runner của lượt cũ tự rút lui. */
  private generation = 0;
  private concurrencyCap: number;
  private completedSegments = 0;
  private deniedStreak = 0;
  private refreshing: Promise<void> | null = null;
  private samples: Array<{ at: number; bytes: number }> = [];
  private progressTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    url: string,
    options: Partial<HlsJobOptions> & Pick<HlsJobOptions, 'writerWorkerUrl'>,
    events: JobEvents = {},
    source: TaskSource = 'manual',
  ) {
    this.options = { ...DEFAULT_HLS_OPTIONS, ...options };
    this.events = events;
    this.concurrencyCap = Math.max(1, this.options.concurrency);
    this.task = {
      id: crypto.randomUUID(),
      source,
      url,
      finalUrl: url,
      filename: this.options.filename ?? 'video',
      size: null,
      state: 'queued',
      received: 0,
      pieces: [],
      error: null,
      createdAt: Date.now(),
      speed: 0,
      // HLS tải theo segment nên khái niệm Range của file đích không áp dụng;
      // để false cho UI khỏi hứa hẹn khả năng resume theo byte.
      acceptRanges: false,
      etag: null,
      lastModified: null,
      mimeType: null,
    };
    this.outputPartName = storage.partName(this.task.id);
  }

  /* ---------- Vòng đời ---------- */

  async start(): Promise<void> {
    try {
      this.setState('probing');
      this.controller = new AbortController();

      const stream = await resolvePlaylist(
        this.task.url,
        this.options.quality,
        this.controller.signal,
        this.options.audioOnly ?? false,
      );
      this.stream = stream;
      this.task.finalUrl = stream.playlistUrl;
      // Bên gọi ghim được TÊN nhưng không ghim được ĐUÔI: đuôi chỉ biết sau khi đọc
      // playlist, và gắn sai đuôi là cách nhanh nhất khiến trình phát từ chối mở file.
      this.task.filename = this.options.filename
        ? withExtension(this.options.filename, stream.plan.extension)
        : stream.filename;
      this.task.mimeType = stream.plan.mimeType;

      if (stream.plan.blocker) throw new Error(stream.plan.blocker);

      // Mọi khóa phải giải được TRƯỚC khi tải một byte nào: phát hiện DRM sau khi
      // người dùng chờ xong 4 GB là kiểu hỏng tệ nhất. Duyệt hết chứ không chỉ khóa
      // đầu, vì playlist hoàn toàn có thể đổi sang SAMPLE-AES ở giữa chừng.
      const checked = new Set<string>();
      for (const segment of stream.media.segments) {
        if (!segment.key) continue;
        const signature = `${segment.key.method}|${segment.key.keyFormat}`;
        if (checked.has(signature)) continue;
        checked.add(signature);
        assertSupported(segment.key);
      }

      this.requests = buildSegmentRequests(stream.media);
      this.task.pieces = this.requests.map(makePiece);
      this.task.size = estimateFromBitrate(stream);

      await this.ensureQuota(this.task.size);
      await storage.removePart(this.task.id);

      this.writer = new SequentialPartWriter(this.outputPartName, this.options.writerWorkerUrl);
      await this.writer.open();
      this.sink = new OrderedSink(this.writer, {
        maxBufferedBytes: this.options.maxBufferedBytes,
        total: this.requests.length,
      });

      this.setState('downloading');
      this.startProgressTicker();
      log('hls', `${this.requests.length} segment, ${this.concurrencyCap} kết nối`);
      this.spawnRunners();
    } catch (err) {
      await this.fail(err instanceof Error ? err.message : String(err));
    }
  }

  pause(): void {
    if (this.task.state !== 'downloading') return;
    this.stopping = true;
    this.controller?.abort();
    this.stopProgressTicker();

    // Segment đã tải xong nhưng còn nằm trong bộ đệm chờ tới lượt sẽ bị bỏ và tải
    // lại khi tiếp tục. Giữ chúng qua một lần tạm dừng nghĩa là giữ tới 64 MB RAM
    // vô thời hạn, cái giá đó lớn hơn vài giây tải lại.
    const from = this.sink?.nextIndex ?? 0;
    this.sink?.reset(from);
    for (const piece of this.task.pieces) {
      if (piece.index >= from) {
        piece.state = 'pending';
        piece.received = 0;
      }
    }
    this.task.received = totalReceived(this.task.pieces);

    this.setState('paused');
    this.stopping = false;
  }

  resume(): void {
    if (this.task.state !== 'paused') return;
    this.controller = new AbortController();
    this.setState('downloading');
    this.startProgressTicker();
    this.spawnRunners();
  }

  async cancel(): Promise<void> {
    this.stopping = true;
    this.finished = true;
    this.controller?.abort();
    this.stopProgressTicker();
    this.writer?.dispose();
    this.writer = null;
    this.keys.clear();
    await storage.removePart(this.task.id);
    await this.removeStrayOutput();
    this.setState('canceled');
  }

  /* ---------- Vòng tải ---------- */

  private spawnRunners(): void {
    this.generation += 1;
    const generation = this.generation;
    const count = Math.max(1, Math.min(this.concurrencyCap, this.requests.length));
    for (let i = 0; i < count; i += 1) void this.runner(i, generation);
  }

  private async runner(slot: number, generation: number): Promise<void> {
    for (;;) {
      if (this.stopping || this.finished || this.task.state !== 'downloading') return;
      // Một runner của lượt trước có thể còn đang ngủ khi người dùng tiếp tục tải;
      // không có mốc thế hệ thì nó thức dậy và chạy song song với đội mới.
      if (generation !== this.generation) return;
      // Gặp segment khổng lồ thì thu hẹp đội; slot 0 luôn sống để job không đứng hẳn.
      if (slot > 0 && slot >= this.concurrencyCap) return;

      const sink = this.sink;
      if (!sink) return;

      // Bộ đệm đầy thì ngừng phát việc mới — trừ khi không còn ai đang tải, vì khi đó
      // chính segment đang chặn hàng đợi lại nằm trong số việc chưa phát, và chờ tiếp
      // là kẹt vĩnh viễn. Ca này xảy ra sau một lần thử lại: segment k quay về hàng
      // chờ trong lúc k+1..k+n đã xong và đang chiếm đệm.
      if (!sink.hasRoom && this.active > 0) {
        await sleep(40, this.controller?.signal);
        continue;
      }

      const piece = takeNextPending(this.task.pieces);
      if (!piece) {
        this.maybeFinish();
        return;
      }

      this.active += 1;
      try {
        await this.handlePiece(piece);
      } finally {
        this.active -= 1;
      }
    }
  }

  private async handlePiece(piece: Piece): Promise<void> {
    for (;;) {
      if (this.stopping || this.finished || this.task.state !== 'downloading') {
        piece.state = 'pending';
        return;
      }

      try {
        const data = await this.fetchSegment(piece.index);
        // Người dùng hoàn toàn có thể đã tạm dừng trong lúc segment này còn trên đường
        // về. `pause()` vừa reset sink và trả piece về hàng chờ đúng để nhả RAM; đẩy
        // tiếp chunk vào đó là nhét lại chính thứ vừa được nhả ra, và nó nằm đấy tới
        // khi nào người dùng tiếp tục.
        if (this.stopping || this.finished || this.task.state !== 'downloading') {
          piece.state = 'pending';
          return;
        }
        this.deniedStreak = 0;

        piece.received = data.byteLength;
        piece.state = 'done';
        this.task.received = totalReceived(this.task.pieces);
        this.samples.push({ at: Date.now(), bytes: data.byteLength });
        // Segment trống (EXT-X-GAP) không nói gì về bitrate; đếm nó vào mẫu chỉ làm
        // ước lượng dung lượng thấp đi một cách giả tạo.
        if (data.byteLength > 0) {
          this.completedSegments += 1;
          this.updateSizeEstimate();
        }

        if (data.byteLength > this.options.hugeSegmentBytes && this.concurrencyCap > 1) {
          warn('hls', `segment ${piece.index} nặng ${data.byteLength} byte, hạ về 1 kết nối`);
          this.concurrencyCap = 1;
        }

        try {
          await this.sink!.put(piece.index, data);
        } catch (err) {
          // Hỏng ở phía ghi chứ không phải phía mạng: tải lại segment cũng vô ích, chỉ
          // tốn thêm năm lượt tải kèm chờ lũy thừa rồi mới chịu báo đúng lỗi.
          throw new SegmentError(
            `Không ghi được xuống đĩa: ${err instanceof Error ? err.message : String(err)}`,
            false,
          );
        }
        return;
      } catch (err) {
        if (this.stopping || this.finished || this.task.state !== 'downloading') {
          piece.state = 'pending';
          return;
        }

        const retryable = err instanceof SegmentError ? err.retryable : !(err instanceof UnsupportedEncryptionError);
        const message = err instanceof Error ? err.message : String(err);

        if (err instanceof SegmentError && err.denied) {
          this.deniedStreak += 1;
          if (this.deniedStreak >= REFRESH_AFTER_DENIED) await this.refreshPlaylist();
        }

        if (!retryable) {
          piece.state = 'failed';
          await this.fail(`Segment ${piece.index}: ${message}`);
          return;
        }

        if (!requeue(piece, this.options.maxRetries)) {
          await this.fail(`Segment ${piece.index} thất bại sau ${piece.attempts} lần: ${message}`);
          return;
        }

        // Giữ lại quyền sở hữu piece thay vì thả về hàng chờ: nếu thả, một runner
        // khác có thể bốc nó ngay lập tức và ta mất luôn phần chờ lũy thừa.
        piece.state = 'active';
        warn('hls', `segment ${piece.index} thử lại lần ${piece.attempts}: ${message}`);
        await this.backoff(piece.attempts);
      }
    }
  }

  /**
   * Chờ lũy thừa kèm nhiễu ngẫu nhiên, khác với engine tải file thường vốn phát lại
   * piece ngay. Một playlist có hàng nghìn segment, và đập liên hồi vào CDN đang giới
   * hạn tần suất chỉ làm tình hình tệ thêm.
   */
  private backoff(attempt: number): Promise<void> {
    const base = Math.min(30_000, 500 * 2 ** Math.max(0, attempt - 1));
    return sleep(Math.round(base * (0.75 + Math.random() * 0.5)), this.controller?.signal);
  }

  private async fetchSegment(index: number): Promise<Uint8Array> {
    const req = this.requests[index];
    if (!req) throw new SegmentError('Không có thông tin segment', false);

    // EXT-X-GAP: server đã nói trước là đoạn này không có. RFC 8216 §4.4.4.7 yêu cầu
    // client đừng tải nó, và planAssembly() cũng đã hứa với người dùng là chỗ đó sẽ
    // trống. Cứ tải liều thì gặp 404, thử lại đủ số lần rồi kéo sập cả lượt tải —
    // tức là từ chối hẳn một playlist mà chính ta vừa bảo người dùng là tải được.
    if (req.gap) return new Uint8Array(0);

    const headers = new Headers();
    if (req.range) headers.set('Range', `bytes=${req.range.start}-${req.range.end}`);

    let res: Response;
    try {
      res = await fetch(req.url, {
        method: 'GET',
        headers,
        credentials: 'include',
        cache: 'no-store',
        redirect: 'follow',
        signal: this.controller?.signal ?? null,
      });
    } catch (err) {
      if (this.controller?.signal.aborted) throw new SegmentError('Đã hủy', false);
      throw new SegmentError(err instanceof Error ? err.message : String(err), true);
    }

    if (!res.ok) {
      res.body?.cancel().catch(() => {});
      const denied = res.status === 401 || res.status === 403;
      // 401/403 vẫn coi là thử lại được vì nguyên nhân thường là chữ ký URL hết hạn,
      // và refreshPlaylist() có thể cứu được. 404 thì thử lại vô ích.
      const retryable = denied || res.status >= 500 || res.status === 429 || res.status === 408;
      throw new SegmentError(`HTTP ${res.status} ${res.statusText}`, retryable, denied);
    }

    // Server phớt lờ header Range là ca hỏng ngầm nguy hiểm nhất của EXT-X-BYTERANGE:
    // body trả về khi đó là CẢ file chứ không phải khoảng đã xin, và ghi nó vào chỗ của
    // một segment cho ra file hỏng mà không có dấu hiệu nào lúc tải. Thà dừng và nói thẳng.
    if (req.range && res.status !== 206) {
      res.body?.cancel().catch(() => {});
      throw new SegmentError(
        `Server không tôn trọng khoảng byte (trả HTTP ${res.status} thay vì 206), nên không tải được playlist dạng EXT-X-BYTERANGE`,
        false,
      );
    }

    // Chú thích kiểu tường minh: giải mã trả về Uint8Array trên ArrayBufferLike,
    // còn suy diễn từ arrayBuffer() lại hẹp hơn nên phép gán sau đó không khớp.
    let data: Uint8Array = new Uint8Array(await res.arrayBuffer());
    if (data.byteLength === 0) throw new SegmentError('Segment rỗng', true);

    if (req.key && req.iv) {
      // Init section thường KHÔNG được mã hóa dù playlist có khóa. Nếu nó đã là box
      // ftyp/styp hợp lệ thì giải mã sẽ biến dữ liệu tốt thành rác, nên kiểm trước.
      if (req.isInit && looksLikeInitSegment(data)) return data;

      let cryptoKey: CryptoKey;
      try {
        cryptoKey = await this.keys.get(req.key, this.controller?.signal);
      } catch (err) {
        if (err instanceof UnsupportedEncryptionError) throw err;
        throw new SegmentError(err instanceof Error ? err.message : String(err), true);
      }

      data = await decryptSegment(data, cryptoKey, req.iv, {
        expectMpegTs: this.stream?.media.container === 'mpegts',
      });

      if (req.isInit && !looksLikeInitSegment(data)) {
        throw new SegmentError('Init segment giải mã ra dữ liệu không hợp lệ', false);
      }
    }

    return data;
  }

  /**
   * Chữ ký URL của CDN thường hết hạn sau 30-60 phút, mà một video dài có hàng nghìn
   * segment. Tải lại playlist rồi ánh xạ URL theo index là nỗ lực tốt nhất có thể;
   * nếu số segment đổi thì bỏ cuộc thay vì ghép nhầm nội dung.
   */
  private refreshPlaylist(): Promise<void> {
    if (this.refreshing) return this.refreshing;

    this.refreshing = (async () => {
      try {
        const fresh = await resolvePlaylist(
          this.task.url,
          this.options.quality,
          this.controller?.signal,
          this.options.audioOnly ?? false,
        );
        const next = buildSegmentRequests(fresh.media);
        if (next.length !== this.requests.length) {
          throw new Error(
            `Playlist đổi từ ${this.requests.length} thành ${next.length} segment giữa chừng`,
          );
        }
        this.requests = next;
        this.stream = fresh;
        this.deniedStreak = 0;
        log('hls', 'đã làm mới playlist sau chuỗi lỗi 401/403');
      } catch (err) {
        warn('hls', 'làm mới playlist thất bại', err);
      } finally {
        this.refreshing = null;
      }
    })();

    return this.refreshing;
  }

  /* ---------- Kết thúc ---------- */

  private maybeFinish(): void {
    if (this.finished || this.active > 0) return;
    if (!isComplete(this.task.pieces)) return;
    this.finished = true;
    void this.finalize();
  }

  private async finalize(): Promise<void> {
    this.stopProgressTicker();
    this.setState('assembling');

    try {
      // Chờ nốt bộ đệm: piece cuối có thể đã 'done' trong lúc chunk trước nó còn
      // đang trên đường xuống đĩa.
      const sink = this.sink;
      for (let i = 0; sink && !sink.done && i < 600; i += 1) await sleep(50);
      if (sink && !sink.done) throw new Error('Còn segment chưa ghi được xuống đĩa');

      const written = (await this.writer?.close()) ?? 0;
      this.writer = null;
      if (written === 0) throw new Error('Không ghi được byte nào');

      await this.applyRemuxer();

      const blobUrl = await this.partBlobUrl();
      this.task.size = written;
      this.task.received = written;
      this.setState('completed');
      this.events.onComplete?.({
        blobUrl,
        filename: this.task.filename,
        size: written,
        mimeType: this.task.mimeType,
      });
    } catch (err) {
      await this.fail(err instanceof Error ? err.message : String(err));
    } finally {
      this.keys.clear();
    }
  }

  /** Chỉ chạy khi ai đó đã cắm muxer thật vào; mặc định không có nên bỏ qua. */
  private async applyRemuxer(): Promise<void> {
    const plan = this.stream?.plan;
    const remuxer = getRemuxer();
    if (!plan || plan.directConcat || !remuxer) return;
    if (!remuxer.supports(plan.container, plan.output)) return;

    this.setState('assembling');
    const result = await remuxer.remux({
      partName: this.outputPartName,
      from: plan.container,
      to: plan.output,
      signal: this.controller?.signal,
    });

    if (result.partName !== this.outputPartName) {
      // File nguồn đã hết vai trò; xóa ngay để không giữ gấp đôi dung lượng.
      const previous = this.outputPartName;
      this.outputPartName = result.partName;
      await removePartByName(previous);
    }
    this.task.mimeType = result.mimeType;
  }

  private async partBlobUrl(): Promise<string> {
    const dir = await storage.partsDirectory();
    const handle = await dir.getFileHandle(this.outputPartName);
    const file = await handle.getFile();
    const blob = this.task.mimeType
      ? file.slice(0, file.size, this.task.mimeType)
      : file;
    return URL.createObjectURL(blob);
  }

  private async removeStrayOutput(): Promise<void> {
    if (this.outputPartName === storage.partName(this.task.id)) return;
    await removePartByName(this.outputPartName);
  }

  private async fail(message: string): Promise<void> {
    if (this.task.state === 'failed' || this.task.state === 'canceled') return;
    this.finished = true;
    this.stopping = true;
    this.controller?.abort();
    this.stopProgressTicker();
    this.writer?.dispose();
    this.writer = null;
    this.keys.clear();
    await storage.removePart(this.task.id);
    await this.removeStrayOutput();

    // Khác DownloadJob: không có đường trả lại cho trình duyệt, vì trình duyệt không
    // biết tải HLS. Nói thẳng lỗi ra là lựa chọn duy nhất trung thực.
    this.task.error = message;
    this.setState('failed', message);
  }

  /* ---------- Tiến độ ---------- */

  private async ensureQuota(estimate: number | null): Promise<void> {
    if (estimate === null || estimate <= 0) return;
    try {
      const info = await storage.quota();
      if (info.quota > 0 && info.available < estimate) {
        throw new Error(
          `Không đủ dung lượng tạm: ước cần ${Math.round(estimate / 1048576)} MB, còn ${Math.round(info.available / 1048576)} MB`,
        );
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Không đủ dung lượng')) throw err;
      // estimate() hỏng thì cứ thử tải; lỗi thật sẽ lộ ra lúc ghi.
    }
  }

  /**
   * Kích thước tổng của một task HLS chỉ là ƯỚC LƯỢNG — không có cách nào biết trước
   * tổng byte của một playlist. Trả null thì thanh tiến độ và ETA chết hẳn, đúng vào
   * lúc người dùng cần chúng nhất (video dài hàng chục phút). Ước lượng hội tụ nhanh
   * vì bitrate HLS khá đều.
   */
  private updateSizeEstimate(): void {
    if (this.completedSegments < ESTIMATE_AFTER) return;
    const perSegment = this.task.received / this.completedSegments;
    this.task.size = Math.round(perSegment * this.requests.length);
  }

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
    const span = this.samples.length ? Math.max(1, now - (this.samples[0]?.at ?? now)) : SPEED_WINDOW_MS;
    this.task.speed = Math.round((bytes * 1000) / span);

    this.events.onProgress?.({
      id: this.task.id,
      received: this.task.received,
      size: this.task.size,
      speed: this.task.speed,
      state: this.task.state,
      activeConnections: this.active,
    });
  }

  private setState(state: DownloadState, error: string | null = null): void {
    this.task.state = state;
    this.events.onState?.(state, error);
  }
}

/**
 * Một Piece = một segment. `start`/`end` để 0 vì với HLS chúng vô nghĩa: segment là
 * đơn vị nguyên, không tương ứng khoảng byte nào biết trước trong file đích. Hệ quả:
 * KHÔNG được gọi `remainingRange()` của pieces.ts lên piece của HLS — chỉ bốn hàm
 * `takeNextPending`/`requeue`/`isComplete`/`totalReceived` là dùng được, và chúng chỉ
 * đụng tới `state`, `attempts`, `received`.
 */
function makePiece(req: SegmentRequest): Piece {
  return { index: req.index, start: 0, end: 0, received: 0, state: 'pending', attempts: 0 };
}

/** Bitrate khai trong master cho một ước lượng thô ngay từ đầu, trước khi có số liệu thật. */
function estimateFromBitrate(stream: ResolvedStream): number | null {
  const bandwidth = stream.variant?.averageBandwidth ?? stream.variant?.bandwidth ?? 0;
  const duration = stream.media.totalDuration;
  if (bandwidth <= 0 || duration <= 0) return null;
  return Math.round((bandwidth / 8) * duration);
}

/** Thay đuôi của một tên file đã ghim sẵn, giữ nguyên phần tên. */
function withExtension(filename: string, extension: string): string {
  const stem = sanitize(filename).replace(/\.[^.]{1,5}$/, '');
  return `${stem || 'video'}${extension}`;
}

async function removePartByName(name: string): Promise<void> {
  try {
    const dir = await storage.partsDirectory();
    await dir.removeEntry(name);
  } catch {
    // Đã bị dọn từ trước, hoặc OPFS không dùng được: không có gì để làm thêm.
  }
}

/* ---------- Kế hoạch tải cho UI ---------- */

export interface MediaDownloadPlan {
  jobs: Array<{ url: string; filename: string; role: 'video' | 'audio' | 'muxed' }>;
  warnings: string[];
  blocker: string | null;
}

/**
 * Từ một URL media ra 1 hoặc 2 job cần tạo.
 *
 * Video có rendition tiếng tách rời cho ra HAI file chứ không phải một, vì ghép chúng
 * cần đúng cái muxer mà cả nhóm này cố tình không viết. Im lặng trả về một file video
 * CÂM là kiểu hỏng tệ nhất — người dùng chỉ phát hiện sau khi tải xong.
 */
export async function planMediaDownload(
  url: string,
  pref: QualityPreference = 'best',
  signal?: AbortSignal,
): Promise<MediaDownloadPlan> {
  if (classifyMediaUrl(url) === 'dash') {
    return {
      jobs: [],
      warnings: [],
      blocker: 'Luồng DASH (.mpd) chưa được hỗ trợ; hiện chỉ tải được HLS (.m3u8).',
    };
  }

  let stream: ResolvedStream;
  try {
    stream = await resolvePlaylist(url, pref, signal);
  } catch (err) {
    return { jobs: [], warnings: [], blocker: err instanceof Error ? err.message : String(err) };
  }

  if (stream.plan.blocker) {
    return { jobs: [], warnings: stream.plan.warnings, blocker: stream.plan.blocker };
  }

  const stem = stream.filename.replace(/\.[^.]+$/, '');
  const jobs: MediaDownloadPlan['jobs'] = [
    {
      // Ghim thẳng URL variant để lựa chọn chất lượng không bị tính lại lệch đi.
      url: stream.variant?.uri ?? stream.playlistUrl,
      filename: stream.filename,
      role: stream.audio ? 'video' : 'muxed',
    },
  ];

  if (stream.audio?.uri) {
    const label = sanitize(stream.audio.language ?? stream.audio.name);
    jobs.push({
      url: stream.audio.uri,
      // Không gắn đuôi ở đây: luồng tiếng có container riêng, và HlsJob sẽ thay đuôi
      // cho đúng sau khi đọc playlist của nó.
      filename: `${stem}.tieng-${label || 'audio'}`,
      role: 'audio',
    });
  }

  return { jobs, warnings: stream.plan.warnings, blocker: null };
}
