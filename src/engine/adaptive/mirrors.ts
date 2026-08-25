/**
 * Nhiều URL cho cùng một file: xác thực chúng đúng là một, rồi chia piece cho
 * nguồn nào đang nhanh và tự rút khỏi nguồn đang chết.
 *
 * Phần khó không nằm ở việc chia việc mà ở việc quyết định khi nào ĐƯỢC PHÉP
 * kết luận. Hai câu hỏi dễ trả lời sai:
 *
 *   - "Hai URL này có cùng một file không?" ETag khác nhau KHÔNG phải bằng chứng
 *     khác file: hai CDN phục vụ cùng một nội dung gần như luôn sinh ETag khác
 *     nhau (inode, thời điểm, thuật toán riêng). Coi ETag lệch là "khác file" sẽ
 *     loại sạch mirror hợp lệ; coi là "giống file" thì liều. Nên kết quả là một
 *     thang bốn mức chứ không phải boolean.
 *   - "Có nên bỏ nguồn này không?" Bỏ piece đang tải dở là vứt đi số byte đã
 *     tải. Chỉ đáng làm khi chắc chắn có chỗ tốt hơn để chuyển sang.
 *
 * Toàn bộ dùng đồng hồ tiêm vào nên test được tất định, không cần mạng.
 */

export interface MirrorSource {
  id: string;
  url: string;
  /** Số lớn hơn được ưu tiên khi điểm bằng nhau. Mặc định 0. */
  priority?: number;
}

export interface MirrorFingerprint {
  size: number | null;
  etag: string | null;
  lastModified: string | null;
  acceptRanges: boolean;
}

export type IdentityVerdict = 'same' | 'likely' | 'unknown' | 'different';

export interface IdentityCheck {
  verdict: IdentityVerdict;
  reason: string;
}

/** Bóc tiền tố `W/` và cặp dấu nháy; phân biệt ETag yếu với mạnh. */
export function normalizeEtag(raw: string | null): { value: string; weak: boolean } | null {
  if (raw === null) return null;
  let text = raw.trim();
  if (text === '') return null;

  let weak = false;
  if (/^W\//i.test(text)) {
    weak = true;
    text = text.slice(2).trim();
  }
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    text = text.slice(1, -1);
  }
  if (text === '') return null;
  return { value: text, weak };
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Tiện ích cho bên gọi: hai URL có cùng origin không (dùng làm tham số sameOrigin). */
export function sameOriginUrls(a: string, b: string): boolean {
  const oa = originOf(a);
  const ob = originOf(b);
  return oa !== null && ob !== null && oa === ob;
}

export function compareFingerprints(
  reference: MirrorFingerprint,
  candidate: MirrorFingerprint,
  sameOrigin: boolean,
): IdentityCheck {
  if (reference.size === null || candidate.size === null) {
    return {
      verdict: 'unknown',
      reason: 'thiếu Content-Length ở ít nhất một nguồn, không có gì để so',
    };
  }

  if (reference.size !== candidate.size) {
    // Đây là bằng chứng chắc chắn duy nhất trong cả hàm này.
    return {
      verdict: 'different',
      reason: `kích thước lệch: ${reference.size} so với ${candidate.size} byte`,
    };
  }

  const a = normalizeEtag(reference.etag);
  const b = normalizeEtag(candidate.etag);

  if (a && b) {
    if (a.value === b.value) {
      // RFC 7232 đòi so sánh MẠNH cho mọi kết luận về byte: chỉ hai ETag mạnh
      // giống nhau mới là bằng chứng trùng từng byte. `W/` chỉ hứa "tương đương
      // về ngữ nghĩa", mà chia piece giữa hai bản chỉ tương đương ngữ nghĩa là
      // ghép ra file hỏng — đúng thứ module này tồn tại để chặn. nginx và Apache
      // đều gắn `W/` cho phản hồi nén nên ca này hoàn toàn không hiếm.
      if (a.weak || b.weak) {
        return {
          verdict: 'likely',
          reason: 'kích thước và ETag khớp nhưng ETag yếu, chưa chắc trùng từng byte',
        };
      }
      return { verdict: 'same', reason: 'kích thước và ETag mạnh đều khớp' };
    }
    if (sameOrigin) {
      // Cùng một server mà trả ETag khác nhau thì đúng là nội dung khác nhau.
      return { verdict: 'different', reason: 'cùng origin nhưng ETag khác nhau' };
    }
    return {
      verdict: 'likely',
      reason: 'kích thước khớp, ETag lệch nhưng khác origin nên đó là chuyện bình thường',
    };
  }

  if (reference.lastModified && candidate.lastModified) {
    if (reference.lastModified === candidate.lastModified) {
      return { verdict: 'likely', reason: 'kích thước và Last-Modified khớp, thiếu ETag' };
    }
    return { verdict: 'likely', reason: 'kích thước khớp nhưng Last-Modified lệch' };
  }

  return { verdict: 'likely', reason: 'kích thước khớp nhưng thiếu ETag để chắc chắn' };
}

/** Đọc một khoảng byte; `end` inclusive, đúng ngữ nghĩa HTTP Range. */
export type RangeReader = (url: string, start: number, end: number) => Promise<Uint8Array>;

const DEFAULT_WINDOW = 64 * 1024;

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/**
 * SHA-256 của ba cửa sổ 64 KiB: đầu, giữa, cuối.
 *
 * Lấy cả phần cuối là điểm quan trọng — hai bản build khác nhau của cùng một
 * release thường giống hệt nhau ở phần đầu. Tổng chi phí 192 KiB mỗi mirror, rẻ
 * hơn nhiều so với tải nhầm nửa file rồi mới phát hiện lệch.
 */
export async function sampleDigest(
  url: string,
  size: number,
  read: RangeReader,
  windowSize: number = DEFAULT_WINDOW,
): Promise<string> {
  if (size <= 0) return 'empty';

  const w = Math.max(1, Math.min(Math.floor(windowSize), size));
  const ranges: Array<[number, number]> = [];

  if (size <= w * 3) {
    // File nhỏ hơn tổng ba cửa sổ thì đọc thẳng cả file, vừa rẻ vừa chính xác hơn.
    ranges.push([0, size - 1]);
  } else {
    const mid = Math.floor(size / 2) - Math.floor(w / 2);
    ranges.push([0, w - 1]);
    ranges.push([mid, mid + w - 1]);
    ranges.push([size - w, size - 1]);
  }

  const parts: Uint8Array[] = [];
  for (const [start, end] of ranges) {
    parts.push(await read(url, start, end));
  }

  // Trộn kích thước và bố cục cửa sổ vào bản băm: hai file khác cỡ không bao giờ
  // được ra cùng một dấu vân, kể cả khi các cửa sổ lấy mẫu trùng nhau.
  const header = new TextEncoder().encode(`df-mirror:${size}:${w}:${ranges.length}\n`);
  let total = header.byteLength;
  for (const p of parts) total += p.byteLength;

  const buffer = new Uint8Array(total);
  buffer.set(header, 0);
  let at = header.byteLength;
  for (const p of parts) {
    buffer.set(p, at);
    at += p.byteLength;
  }

  const digest = await globalThis.crypto.subtle.digest('SHA-256', buffer);
  return toHex(digest);
}

/** Phân xử khi compareFingerprints trả 'likely'. */
export async function verifyByContent(
  reference: { url: string; size: number },
  candidate: { url: string; size: number },
  read: RangeReader,
  windowSize: number = DEFAULT_WINDOW,
): Promise<IdentityCheck> {
  if (reference.size !== candidate.size) {
    return { verdict: 'different', reason: 'kích thước lệch, không cần lấy mẫu' };
  }

  const [a, b] = await Promise.all([
    sampleDigest(reference.url, reference.size, read, windowSize),
    sampleDigest(candidate.url, candidate.size, read, windowSize),
  ]);

  if (a === b) {
    return { verdict: 'same', reason: 'ba cửa sổ mẫu cho cùng một mã băm' };
  }
  return { verdict: 'different', reason: 'mẫu nội dung khác nhau' };
}

export type MirrorState = 'trial' | 'active' | 'probation' | 'dead';
export type MirrorFailure = 'network' | 'throttled' | 'notfound' | 'mismatch' | 'timeout';

/** Câu giải thích cho UI; người dùng thấy "nguồn 2 đã tắt" mà không hiểu vì sao thì vô ích. */
const FAILURE_REASON: Record<MirrorFailure, string> = {
  network: 'lỗi mạng hoặc kết nối bị đóng giữa chừng',
  throttled: 'server đang bóp số kết nối',
  notfound: 'không còn file này ở nguồn đó',
  mismatch: 'nội dung không khớp với các nguồn khác',
  timeout: 'server không phản hồi kịp',
};

export interface MirrorStats {
  id: string;
  url: string;
  state: MirrorState;
  /** Byte/giây, trung bình trượt theo hàm mũ. */
  throughput: number;
  inFlight: number;
  bytes: number;
  completedPieces: number;
  consecutiveFailures: number;
  throttleHits: number;
  retryAt: number | null;
  acceptRanges: boolean;
  /** Vì sao nguồn này bị phạt hoặc bị loại; null khi chưa có sự cố nào. */
  lastError: string | null;
}

export interface MirrorPoolOptions {
  /**
   * Trần kết nối cho MỘT nguồn. Bên gọi PHẢI truyền `options.connections` của
   * lượt tải vào đây: pool cũng là đường đi của lượt tải chỉ có một URL, nên để
   * số này thấp hơn trần kết nối là âm thầm bóp mọi lượt tải bình thường.
   */
  maxPerMirror: number;
  ewmaAlpha: number;
  failuresToProbation: number;
  probationBackoffMs: number;
  maxProbationMs: number;
  deadAfterProbations: number;
  /** Chậm hơn nguồn tốt nhất bấy nhiêu lần thì mới đáng bỏ piece đang dở. */
  slowFactor: number;
  minSampleBytes: number;
  minSampleMs: number;
}

export const DEFAULT_MIRROR_POOL: MirrorPoolOptions = {
  // Bằng đúng DEFAULT_OPTIONS.connections của engine, để pool một nguồn không
  // trở thành cái phanh vô hình.
  maxPerMirror: 8,
  ewmaAlpha: 0.3,
  failuresToProbation: 3,
  probationBackoffMs: 5000,
  maxProbationMs: 120000,
  deadAfterProbations: 3,
  slowFactor: 4,
  minSampleBytes: 2 * 1024 * 1024,
  minSampleMs: 3000,
};

interface Entry {
  source: MirrorSource;
  order: number;
  state: MirrorState;
  throughput: number;
  samples: number;
  inFlight: number;
  bytes: number;
  completedPieces: number;
  consecutiveFailures: number;
  throttleHits: number;
  probations: number;
  retryAt: number | null;
  backoffMs: number;
  acceptRanges: boolean;
  etag: string | null;
  lastModified: string | null;
  lastError: string | null;
}

export class MirrorPool {
  private readonly entries = new Map<string, Entry>();
  private readonly options: MirrorPoolOptions;
  private readonly nowFn: () => number;
  private counter = 0;

  constructor(
    sources: MirrorSource[],
    options: Partial<MirrorPoolOptions> = {},
    now: () => number = () => Date.now(),
  ) {
    this.options = { ...DEFAULT_MIRROR_POOL, ...options };
    this.nowFn = now;
    for (const source of sources) this.add(source);
  }

  get size(): number {
    return this.entries.size;
  }

  /** Số nguồn đang dùng được ngay lúc này (không chết, không trong thời gian phạt). */
  get usable(): number {
    const now = this.nowFn();
    let count = 0;
    for (const entry of this.entries.values()) {
      if (this.isUsable(entry, now)) count += 1;
    }
    return count;
  }

  add(source: MirrorSource, fingerprint?: MirrorFingerprint): void {
    const existing = this.entries.get(source.id);
    if (existing) {
      if (fingerprint) this.applyFingerprint(existing, fingerprint);
      return;
    }
    const entry: Entry = {
      source,
      order: this.counter++,
      state: 'trial',
      throughput: 0,
      samples: 0,
      inFlight: 0,
      bytes: 0,
      completedPieces: 0,
      consecutiveFailures: 0,
      throttleHits: 0,
      probations: 0,
      retryAt: null,
      backoffMs: this.options.probationBackoffMs,
      // Chưa biết thì cứ giả định là có: thăm dò sẽ nói sự thật, còn giả định
      // ngược lại sẽ loại oan mọi nguồn chưa kịp đo.
      acceptRanges: true,
      etag: null,
      lastModified: null,
      lastError: null,
    };
    if (fingerprint) this.applyFingerprint(entry, fingerprint);
    this.entries.set(source.id, entry);
  }

  /** Cập nhật dấu vân sau khi thăm dò xong một nguồn đã có trong pool. */
  setFingerprint(id: string, fingerprint: MirrorFingerprint): void {
    const entry = this.entries.get(id);
    if (entry) this.applyFingerprint(entry, fingerprint);
  }

  disable(id: string, reason: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.state = 'dead';
    entry.retryAt = null;
    entry.lastError = reason;
  }

  /**
   * Nguồn tốt nhất còn chỗ; tăng inFlight. null nghĩa là mọi nguồn đều bận,
   * đang bị phạt, hoặc đã chết.
   */
  acquire(opts: { requireRanges?: boolean; exclude?: ReadonlySet<string> } = {}): MirrorSource | null {
    const now = this.nowFn();
    const candidates: Entry[] = [];

    for (const entry of this.entries.values()) {
      if (entry.state === 'dead') continue;
      if (opts.exclude?.has(entry.source.id)) continue;
      if (entry.inFlight >= this.options.maxPerMirror) continue;
      if (opts.requireRanges === true && !entry.acceptRanges) continue;

      if (entry.state === 'probation') {
        if (entry.retryAt !== null && now < entry.retryAt) continue;
        // Hết hạn phạt: cho chạy thử lại một piece để tự chứng minh.
        entry.state = 'trial';
        entry.retryAt = null;
      }
      candidates.push(entry);
    }

    if (candidates.length === 0) return null;

    // Nguồn chưa có số đo nào được ưu tiên chạy thử. Nếu chỉ xếp theo throughput
    // thì nguồn nhanh nhất ôm hết piece và nguồn thứ hai vĩnh viễn không có số đo
    // để cạnh tranh.
    //
    // "Chạy thử" là MỘT kết nối chứ không phải tất cả. Lọc theo mỗi `samples === 0`
    // thì một nguồn treo — nhận kết nối nhưng không trả byte nào nên mãi mãi không
    // có mẫu — hút trọn maxPerMirror kết nối trong khi nguồn đã đo được 100 MB/s
    // ngồi không, và phải chờ đủ `failuresToProbation` lần timeout mới thoát ra.
    // Đã có một kết nối đang thử rồi thì nó phải tự cạnh tranh bằng điểm.
    const untried = candidates.filter((e) => e.samples === 0 && e.inFlight === 0);
    const pool = untried.length > 0 ? untried : candidates;

    let best = pool[0]!;
    for (const entry of pool) {
      if (this.better(entry, best)) best = entry;
    }

    best.inFlight += 1;
    return best.source;
  }

  release(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.inFlight = Math.max(0, entry.inFlight - 1);
  }

  /**
   * CỐ Ý không xóa `consecutiveFailures` ở đây, chỉ `notePieceDone` mới được xóa.
   * Kiểu hỏng phổ biến nhất của một mirror là "tải được vài MB rồi đứt", lặp mãi.
   * Nếu vài byte đầu tiên đã đủ xóa bộ đếm thì nguồn đó không bao giờ đạt tới
   * `failuresToProbation` và cả cơ chế phạt trở thành code chết.
   */
  noteBytes(id: string, bytes: number, elapsedMs: number): void {
    const entry = this.entries.get(id);
    if (!entry || bytes <= 0) return;

    entry.bytes += bytes;

    if (elapsedMs <= 0) return;
    const rate = (bytes * 1000) / elapsedMs;
    entry.throughput =
      entry.samples === 0
        ? rate
        : entry.throughput + this.options.ewmaAlpha * (rate - entry.throughput);
    entry.samples += 1;
    if (entry.state === 'trial') entry.state = 'active';
  }

  notePieceDone(id: string, bytes: number, elapsedMs: number): void {
    this.noteBytes(id, bytes, elapsedMs);
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.completedPieces += 1;
    entry.consecutiveFailures = 0;
    entry.backoffMs = this.options.probationBackoffMs;
    entry.lastError = null;
    if (entry.state !== 'dead') {
      entry.state = 'active';
      // Một piece trọn vẹn về đích chính là bằng chứng nguồn đã sống lại. Bỏ quên
      // retryAt ở đây thì UI vẫn khoe một hạn phạt đã hết nghĩa, còn stats() thì
      // tự mâu thuẫn: trạng thái 'active' mà lại kèm mốc chờ.
      entry.retryAt = null;
    }
  }

  noteFailure(id: string, kind: MirrorFailure): void {
    const entry = this.entries.get(id);
    if (!entry || entry.state === 'dead') return;

    if (kind === 'throttled') entry.throttleHits += 1;
    entry.lastError = FAILURE_REASON[kind];

    if (kind === 'notfound' || kind === 'mismatch') {
      // 404 hoặc "không phải file này" là kết luận cuối cùng: chờ thêm vô nghĩa.
      entry.state = 'dead';
      entry.retryAt = null;
      return;
    }

    entry.consecutiveFailures += 1;
    if (entry.consecutiveFailures < this.options.failuresToProbation) return;

    entry.consecutiveFailures = 0;
    entry.probations += 1;
    if (entry.probations >= this.options.deadAfterProbations) {
      entry.state = 'dead';
      entry.retryAt = null;
      return;
    }

    entry.state = 'probation';
    entry.retryAt = this.nowFn() + entry.backoffMs;
    entry.backoffMs = Math.min(this.options.maxProbationMs, entry.backoffMs * 2);
  }

  /**
   * Ba điều kiện phải đúng cùng lúc. Điều kiện thứ ba hay bị quên, và thiếu nó
   * thì bộ chuyển nguồn biến thành cỗ máy hủy tiến độ mỗi khi cả pool đều chậm
   * (mà thực ra là mạng nhà đang chậm).
   */
  shouldAbandon(id: string, pieceBytes: number, pieceElapsedMs: number): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;

    // 1. Đã đo đủ lâu và đủ nhiều để con số có nghĩa.
    if (pieceBytes < this.options.minSampleBytes) return false;
    if (pieceElapsedMs < this.options.minSampleMs) return false;

    const rate = pieceElapsedMs > 0 ? (pieceBytes * 1000) / pieceElapsedMs : 0;
    const now = this.nowFn();

    let bestAlternative = 0;
    let hasRoom = false;
    for (const other of this.entries.values()) {
      if (other.source.id === id) continue;
      if (!this.isUsable(other, now)) continue;
      if (other.inFlight >= this.options.maxPerMirror) continue;
      hasRoom = true;
      if (other.throughput > bestAlternative) bestAlternative = other.throughput;
    }

    // 3. Có nguồn khác còn chỗ trống để chuyển sang.
    if (!hasRoom) return false;
    // Nguồn thay thế chưa có số đo thì chuyển sang là đánh bạc, không phải quyết định.
    if (bestAlternative <= 0) return false;

    // 2. Chậm hơn nguồn tốt nhất quá slowFactor lần.
    return rate * this.options.slowFactor < bestAlternative;
  }

  /**
   * Validator riêng của từng mirror. ETag của mirror A gửi kèm If-Range cho
   * mirror B là vô nghĩa và sẽ khiến server trả 200 thay vì 206.
   */
  validatorFor(id: string): { etag: string | null; lastModified: string | null } | null {
    const entry = this.entries.get(id);
    if (!entry) return null;
    return { etag: entry.etag, lastModified: entry.lastModified };
  }

  stats(): MirrorStats[] {
    return [...this.entries.values()].map((entry) => ({
      id: entry.source.id,
      url: entry.source.url,
      state: entry.state,
      throughput: entry.throughput,
      inFlight: entry.inFlight,
      bytes: entry.bytes,
      completedPieces: entry.completedPieces,
      consecutiveFailures: entry.consecutiveFailures,
      throttleHits: entry.throttleHits,
      retryAt: entry.retryAt,
      acceptRanges: entry.acceptRanges,
      lastError: entry.lastError,
    }));
  }

  best(): MirrorStats | null {
    const now = this.nowFn();
    let winner: Entry | null = null;
    for (const entry of this.entries.values()) {
      if (!this.isUsable(entry, now)) continue;
      if (!winner || entry.throughput > winner.throughput) winner = entry;
    }
    if (!winner) return null;
    const id = winner.source.id;
    return this.stats().find((s) => s.id === id) ?? null;
  }

  /* ---------- Nội bộ ---------- */

  private applyFingerprint(entry: Entry, fingerprint: MirrorFingerprint): void {
    entry.acceptRanges = fingerprint.acceptRanges;
    entry.etag = fingerprint.etag;
    entry.lastModified = fingerprint.lastModified;
  }

  private isUsable(entry: Entry, now: number): boolean {
    if (entry.state === 'dead') return false;
    if (entry.state === 'probation' && entry.retryAt !== null && now < entry.retryAt) return false;
    return true;
  }

  /**
   * Chia cho (1 + inFlight) là hình phạt tải: không có nó thì nguồn nhanh nhất
   * ôm hết mọi piece và ta mất khả năng chạy song song nhiều nguồn.
   */
  private scoreOf(entry: Entry): number {
    return entry.throughput / (1 + entry.inFlight);
  }

  private better(a: Entry, b: Entry): boolean {
    const sa = this.scoreOf(a);
    const sb = this.scoreOf(b);
    if (sa !== sb) return sa > sb;

    const pa = a.source.priority ?? 0;
    const pb = b.source.priority ?? 0;
    if (pa !== pb) return pa > pb;

    if (a.inFlight !== b.inFlight) return a.inFlight < b.inFlight;
    return a.order < b.order;
  }
}
