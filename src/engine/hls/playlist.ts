/**
 * Parser M3U8 thuần.
 *
 * Không fetch, không DOM, không API extension — chỉ nhận một chuỗi và một baseUrl.
 * Lý do: đây là phần dày logic nhất và cũng dễ sai nhất của cả nhóm HLS (danh sách
 * thuộc tính có dấu phẩy nằm trong chuỗi nháy, BYTERANGE nối tiếp ngầm, EXT-X-KEY
 * có tầm ảnh hưởng trải dài qua nhiều segment). Thuần hóa nó cho phép test bằng
 * playlist mẫu viết thẳng trong file test, không cần mạng cũng không cần trình duyệt.
 *
 * Mọi URI trả ra đã được resolve tuyệt đối và đã lọc theo scheme: nội dung playlist
 * là dữ liệu do server lạ cung cấp, mà engine lại fetch với `credentials: 'include'`
 * và host_permissions <all_urls>, nên một URI `file://` hay `chrome-extension://`
 * lọt vào đây là một mũi tấn công thật chứ không phải giả thuyết.
 */

export type PlaylistKind = 'master' | 'media';
export type EncryptionMethod = 'NONE' | 'AES-128' | 'SAMPLE-AES' | 'UNKNOWN';
export type SegmentContainer = 'fmp4' | 'mpegts' | 'aac' | 'mp3' | 'webvtt' | 'unknown';
export type MediaType = 'AUDIO' | 'VIDEO' | 'SUBTITLES' | 'CLOSED-CAPTIONS';
export type PlaylistErrorCode = 'not-m3u8' | 'empty' | 'no-segments' | 'bad-uri' | 'bad-range';

export interface Resolution {
  width: number;
  height: number;
}

/** Đúng ngữ nghĩa EXT-X-BYTERANGE: độ dài trước, offset sau. */
export interface ByteRange {
  length: number;
  offset: number;
}

export interface InitSegment {
  uri: string;
  byteRange: ByteRange | null;
}

export interface KeyInfo {
  method: EncryptionMethod;
  /** Giữ nguyên văn để câu báo lỗi nói được đúng thứ server gửi. */
  rawMethod: string;
  /** null khi METHOD=NONE. Đã resolve tuyệt đối. */
  uri: string | null;
  /** null nghĩa là phải dựng IV từ số thứ tự media. */
  iv: Uint8Array | null;
  keyFormat: string;
  keyFormatVersions: string;
}

export interface Variant {
  uri: string;
  bandwidth: number;
  averageBandwidth: number | null;
  resolution: Resolution | null;
  codecs: string[];
  frameRate: number | null;
  /** Khác null nghĩa là tiếng nằm ở luồng riêng — không ghép được nếu thiếu muxer. */
  audioGroup: string | null;
  subtitleGroup: string | null;
}

export interface Rendition {
  type: MediaType;
  groupId: string;
  name: string;
  language: string | null;
  /** null nghĩa là luồng này đã ghép sẵn trong variant, không có playlist riêng. */
  uri: string | null;
  isDefault: boolean;
  autoselect: boolean;
  channels: string | null;
}

export interface Segment {
  index: number;
  /** Dùng dựng IV mặc định theo RFC 8216 §5.2. */
  mediaSequence: number;
  uri: string;
  duration: number;
  title: string | null;
  byteRange: ByteRange | null;
  /** null nghĩa là segment không mã hóa. */
  key: KeyInfo | null;
  map: InitSegment | null;
  discontinuity: boolean;
  /** EXT-X-GAP: server báo trước là segment này không tải được. */
  gap: boolean;
}

export interface MasterPlaylist {
  kind: 'master';
  variants: Variant[];
  renditions: Rendition[];
  sessionKeys: KeyInfo[];
}

export interface MediaPlaylist {
  kind: 'media';
  version: number;
  targetDuration: number;
  mediaSequence: number;
  isLive: boolean;
  hasEndList: boolean;
  playlistType: 'VOD' | 'EVENT' | null;
  segments: Segment[];
  totalDuration: number;
  /** Nhiều hơn một phần tử nghĩa là không nối thẳng được thành một file hợp lệ. */
  initSegments: InitSegment[];
  hasDiscontinuity: boolean;
  container: SegmentContainer;
  /** Mọi METHOD thực sự áp lên segment, đã lọc trùng. */
  encryption: EncryptionMethod[];
}

export type Playlist = MasterPlaylist | MediaPlaylist;

export class PlaylistError extends Error {
  constructor(message: string, readonly code: PlaylistErrorCode) {
    super(message);
    this.name = 'PlaylistError';
  }
}

/* ---------- Tiện ích chung ---------- */

const SAFE_SCHEMES = new Set(['http:', 'https:']);

/** Cắt ngắn chuỗi lạ trước khi nhét vào thông báo lỗi, tránh đổ cả playlist ra log. */
function short(text: string): string {
  const clean = text.replace(new RegExp('[\\u0000-\\u001F]', 'g'), ' ').trim();
  return clean.length > 80 ? `${clean.slice(0, 77)}...` : clean;
}

/**
 * Resolve URI tương đối và chặn scheme lạ ngay tại cửa.
 * `allowData` chỉ bật cho URI khóa: khóa nhúng dạng data: không gọi mạng nên vô hại,
 * còn segment thì bắt buộc phải là http(s).
 */
function resolveUri(raw: string, baseUrl: string, allowData = false): string {
  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed, baseUrl);
  } catch {
    throw new PlaylistError(`URI trong playlist không hợp lệ: ${short(trimmed)}`, 'bad-uri');
  }
  if (SAFE_SCHEMES.has(url.protocol)) return url.href;
  if (allowData && url.protocol === 'data:') return url.href;
  throw new PlaylistError(
    `Từ chối URI ngoài http/https trong playlist: ${short(trimmed)}`,
    'bad-uri',
  );
}

function toInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function toFloat(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Tách một danh sách thuộc tính kiểu `A=1,B="x,y",C=0xAB`.
 *
 * Không dùng split(',') được vì giá trị trong dấu nháy hoàn toàn có thể chứa dấu
 * phẩy — CODECS="avc1.4d401f,mp4a.40.2" là ca gặp ở gần như mọi master playlist,
 * và tách sai chỗ này làm hỏng toàn bộ danh sách variant chứ không chỉ một trường.
 */
export function parseAttributes(input: string): Map<string, string> {
  const out = new Map<string, string>();
  const n = input.length;
  let i = 0;

  while (i < n) {
    while (i < n && (input[i] === ',' || input[i] === ' ' || input[i] === '\t')) i += 1;
    if (i >= n) break;

    const keyStart = i;
    while (i < n && input[i] !== '=' && input[i] !== ',') i += 1;
    const key = input.slice(keyStart, i).trim().toUpperCase();

    if (i >= n || input[i] === ',') {
      // Thuộc tính cụt (không có dấu bằng). Bỏ qua nó chứ đừng bỏ cả dòng: một
      // trường lạ không được phép làm mất BANDWIDTH của cùng dòng đó.
      continue;
    }

    i += 1; // bỏ dấu '='
    while (i < n && (input[i] === ' ' || input[i] === '\t')) i += 1;

    let value: string;
    if (input[i] === '"') {
      i += 1;
      const start = i;
      while (i < n && input[i] !== '"') i += 1;
      value = input.slice(start, i);
      if (i < n) i += 1; // bỏ dấu nháy đóng
      while (i < n && input[i] !== ',') i += 1; // bỏ rác giữa nháy đóng và dấu phẩy
    } else {
      const start = i;
      while (i < n && input[i] !== ',') i += 1;
      value = input.slice(start, i).trim();
    }

    if (key) out.set(key, value);
  }

  return out;
}

/**
 * `n@o` hoặc `n`. Thiếu offset thì nối tiếp ngay sau sub-range trước của cùng URI —
 * đây là chỗ dễ quên nhất của EXT-X-BYTERANGE và quên thì mọi segment sau đều lệch.
 */
export function parseByteRange(value: string, previousEnd: number | null): ByteRange | null {
  const text = value.trim();
  if (!text) return null;

  const at = text.indexOf('@');
  const lengthPart = at >= 0 ? text.slice(0, at) : text;
  const length = Number.parseInt(lengthPart, 10);
  if (!Number.isFinite(length) || length <= 0) return null;

  if (at >= 0) {
    const offset = Number.parseInt(text.slice(at + 1), 10);
    if (!Number.isFinite(offset) || offset < 0) return null;
    return { length, offset };
  }

  if (previousEnd === null) return null;
  return { length, offset: previousEnd };
}

/** IV phải đúng 128 bit. Đoán bù cho chuỗi thiếu chữ số sẽ cho ra IV sai lặng lẽ. */
export function parseHexIv(value: string): Uint8Array | null {
  const text = value.trim();
  if (!/^0[xX][0-9a-fA-F]+$/.test(text)) return null;
  const hex = text.slice(2);
  if (hex.length !== 32) return null;

  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

const EXTENSION_CONTAINER: Record<string, SegmentContainer> = {
  ts: 'mpegts',
  tsv: 'mpegts',
  tsa: 'mpegts',
  m2ts: 'mpegts',
  mp4: 'fmp4',
  m4s: 'fmp4',
  m4v: 'fmp4',
  m4a: 'fmp4',
  m4f: 'fmp4',
  fmp4: 'fmp4',
  cmfv: 'fmp4',
  cmfa: 'fmp4',
  cmft: 'fmp4',
  aac: 'aac',
  ac3: 'aac',
  mp3: 'mp3',
  vtt: 'webvtt',
  webvtt: 'webvtt',
};

/**
 * EXT-X-MAP là bằng chứng chắc chắn nhất: chỉ fMP4 mới cần init segment.
 * Khi không có nó thì đoán theo đuôi file, và URI hoàn toàn không có đuôi (rất phổ
 * biến ở CDN sinh segment động) được coi là MPEG-TS vì đó là định dạng mặc định
 * lịch sử của HLS — đoán 'unknown' ở đây sẽ chặn oan phần lớn playlist thật.
 */
export function detectContainer(firstSegmentUri: string, hasMap: boolean): SegmentContainer {
  if (hasMap) return 'fmp4';

  let pathname = firstSegmentUri;
  try {
    pathname = new URL(firstSegmentUri).pathname;
  } catch {
    // URI tương đối chưa resolve được thì cứ soi nguyên chuỗi.
    const cut = pathname.search(/[?#]/);
    if (cut >= 0) pathname = pathname.slice(0, cut);
  }

  const last = pathname.split('/').pop() ?? '';
  const dot = last.lastIndexOf('.');
  if (dot < 0) return 'mpegts';

  const ext = last.slice(dot + 1).toLowerCase();
  return EXTENSION_CONTAINER[ext] ?? 'unknown';
}

export function containerExtension(container: SegmentContainer): string {
  switch (container) {
    case 'fmp4':
      return '.mp4';
    case 'mpegts':
      return '.ts';
    case 'aac':
      return '.aac';
    case 'mp3':
      return '.mp3';
    case 'webvtt':
      return '.vtt';
    default:
      return '.bin';
  }
}

export function containerMime(container: SegmentContainer): string {
  switch (container) {
    case 'fmp4':
      return 'video/mp4';
    case 'mpegts':
      return 'video/mp2t';
    case 'aac':
      return 'audio/aac';
    case 'mp3':
      return 'audio/mpeg';
    case 'webvtt':
      return 'text/vtt';
    default:
      return 'application/octet-stream';
  }
}

/* ---------- Đọc dòng ---------- */

interface Line {
  /** Tên tag đã viết hoa, không gồm dấu '#'. null nghĩa là dòng URI. */
  tag: string | null;
  /** Phần sau dấu ':' của tag, hoặc chính URI. */
  value: string;
}

function splitLines(text: string): Line[] {
  // BOM lọt vào đầu file làm '#EXTM3U' không còn khớp và cả playlist bị coi là rác.
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const out: Line[] = [];

  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('#')) {
      if (!line.startsWith('#EXT')) continue; // dòng bình luận thuần
      const colon = line.indexOf(':');
      if (colon < 0) out.push({ tag: line.slice(1).toUpperCase(), value: '' });
      else out.push({ tag: line.slice(1, colon).toUpperCase(), value: line.slice(colon + 1) });
    } else {
      out.push({ tag: null, value: line });
    }
  }

  return out;
}

export function looksLikeM3u8(text: string): boolean {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    return line.startsWith('#EXTM3U');
  }
  return false;
}

/* ---------- EXT-X-KEY ---------- */

function normalizeMethod(raw: string): EncryptionMethod {
  const m = raw.trim().toUpperCase();
  if (m === 'NONE') return 'NONE';
  if (m === 'AES-128') return 'AES-128';
  if (m === 'SAMPLE-AES' || m === 'SAMPLE-AES-CTR' || m === 'SAMPLE-AES-CENC') return 'SAMPLE-AES';
  return 'UNKNOWN';
}

function parseKey(value: string, baseUrl: string): KeyInfo {
  const attrs = parseAttributes(value);
  const rawMethod = attrs.get('METHOD') ?? '';
  const method = normalizeMethod(rawMethod);
  const uriAttr = attrs.get('URI');
  const ivAttr = attrs.get('IV');

  return {
    method,
    rawMethod: rawMethod || 'NONE',
    uri: method === 'NONE' || !uriAttr ? null : resolveUri(uriAttr, baseUrl, true),
    iv: ivAttr ? parseHexIv(ivAttr) : null,
    keyFormat: attrs.get('KEYFORMAT') || 'identity',
    keyFormatVersions: attrs.get('KEYFORMATVERSIONS') || '1',
  };
}

/**
 * Nhiều EXT-X-KEY cùng hiệu lực khi playlist gói kèm vài hệ DRM song song.
 * Ưu tiên `identity` (AES-128 thường) vì đó là thứ duy nhất ta giải được; nếu không
 * có thì trả về cái đầu tiên để assertSupported còn nói được tên hệ DRM cho người dùng.
 */
function chooseKey(active: Map<string, KeyInfo>): KeyInfo | null {
  if (active.size === 0) return null;
  const identity = active.get('identity');
  if (identity) return identity;
  for (const key of active.values()) return key;
  return null;
}

/* ---------- Master playlist ---------- */

function parseResolution(value: string | undefined): Resolution | null {
  if (!value) return null;
  const m = /^(\d+)\s*[xX]\s*(\d+)$/.exec(value.trim());
  if (!m) return null;
  return { width: Number(m[1]), height: Number(m[2]) };
}

function parseMediaType(value: string | undefined): MediaType | null {
  switch ((value ?? '').trim().toUpperCase()) {
    case 'AUDIO':
      return 'AUDIO';
    case 'VIDEO':
      return 'VIDEO';
    case 'SUBTITLES':
      return 'SUBTITLES';
    case 'CLOSED-CAPTIONS':
      return 'CLOSED-CAPTIONS';
    default:
      return null;
  }
}

export function parseMaster(text: string, baseUrl: string): MasterPlaylist {
  const lines = splitLines(text);
  const variants: Variant[] = [];
  const renditions: Rendition[] = [];
  const sessionKeys: KeyInfo[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;

    if (line.tag === 'EXT-X-MEDIA') {
      const attrs = parseAttributes(line.value);
      const type = parseMediaType(attrs.get('TYPE'));
      const groupId = attrs.get('GROUP-ID');
      if (!type || !groupId) continue;

      const uri = attrs.get('URI');
      renditions.push({
        type,
        groupId,
        name: attrs.get('NAME') || groupId,
        language: attrs.get('LANGUAGE') || null,
        // CLOSED-CAPTIONS nằm trong luồng video nên không bao giờ có URI riêng.
        uri: uri && type !== 'CLOSED-CAPTIONS' ? resolveUri(uri, baseUrl) : null,
        isDefault: (attrs.get('DEFAULT') ?? '').toUpperCase() === 'YES',
        autoselect: (attrs.get('AUTOSELECT') ?? '').toUpperCase() === 'YES',
        channels: attrs.get('CHANNELS') || null,
      });
      continue;
    }

    if (line.tag === 'EXT-X-SESSION-KEY') {
      sessionKeys.push(parseKey(line.value, baseUrl));
      continue;
    }

    // EXT-X-I-FRAME-STREAM-INF cố tình bị bỏ qua: nó chỉ chứa khung hình khóa dùng
    // cho tua nhanh, tải về sẽ ra một video giật cục chứ không phải bản đầy đủ.
    if (line.tag !== 'EXT-X-STREAM-INF') continue;

    const attrs = parseAttributes(line.value);

    // URI nằm ở dòng kế tiếp không phải tag. Bình luận có thể chen vào giữa.
    let uri: string | null = null;
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j]!;
      if (next.tag === null) {
        uri = next.value;
        i = j;
        break;
      }
      if (next.tag === 'EXT-X-STREAM-INF') break; // tag này thiếu URI, bỏ luôn
    }
    if (!uri) continue;

    const codecs = attrs.get('CODECS');
    variants.push({
      uri: resolveUri(uri, baseUrl),
      bandwidth: toInt(attrs.get('BANDWIDTH'), 0),
      averageBandwidth: attrs.has('AVERAGE-BANDWIDTH')
        ? toInt(attrs.get('AVERAGE-BANDWIDTH'), 0)
        : null,
      resolution: parseResolution(attrs.get('RESOLUTION')),
      codecs: codecs ? codecs.split(',').map((c) => c.trim()).filter(Boolean) : [],
      frameRate: attrs.has('FRAME-RATE') ? toFloat(attrs.get('FRAME-RATE'), 0) : null,
      audioGroup: attrs.get('AUDIO') || null,
      subtitleGroup: attrs.get('SUBTITLES') || null,
    });
  }

  return { kind: 'master', variants, renditions, sessionKeys };
}

/* ---------- Media playlist ---------- */

export function parseMedia(text: string, baseUrl: string): MediaPlaylist {
  const lines = splitLines(text);

  let version = 1;
  let targetDuration = 0;
  let mediaSequence = 0;
  let hasEndList = false;
  let playlistType: 'VOD' | 'EVENT' | null = null;

  const segments: Segment[] = [];
  const initSegments: InitSegment[] = [];
  const activeKeys = new Map<string, KeyInfo>();

  let pendingDuration: number | null = null;
  let pendingTitle: string | null = null;
  let pendingByteRangeRaw: string | null = null;
  let pendingDiscontinuity = false;
  let pendingGap = false;
  let currentMap: InitSegment | null = null;

  /** Offset cuối của sub-range trước, tra theo URI — BYTERANGE thiếu offset dựa vào nó. */
  const rangeCursor = new Map<string, number>();

  for (const line of lines) {
    if (line.tag === null) {
      // Dòng URI: chốt lại một segment bằng mọi thẻ đang treo phía trên nó.
      if (pendingDuration === null) continue; // URI không có EXTINF đi kèm thì không phải segment

      const uri = resolveUri(line.value, baseUrl);
      // Offset ngầm của BYTERANGE chỉ tính được ở đây, vì nó phụ thuộc sub-range
      // trước đó CỦA CÙNG URI mà URI thì nằm ở dòng này chứ không nằm ở thẻ.
      let byteRange: ByteRange | null = null;
      if (pendingByteRangeRaw !== null) {
        byteRange = parseByteRange(pendingByteRangeRaw, rangeCursor.get(uri) ?? null);
        // Đọc không ra khoảng byte thì phải dừng, tuyệt đối không được rơi về null.
        // null nghĩa là segment mất header Range, mà URI của một playlist BYTERANGE
        // lại thường trỏ tới NGUYÊN file media vài GB: server sẽ vui vẻ trả HTTP 200
        // kèm cả file, phép kiểm 206 ở fetchSegment không chạy vì không có range để
        // kiểm, và cả bộ phim bị ghi vào chỗ của một segment. Hỏng lặng lẽ, đúng kiểu
        // chỉ lộ ra sau khi người dùng đã chờ xong.
        if (!byteRange) {
          throw new PlaylistError(
            `EXT-X-BYTERANGE không đọc được ("${short(pendingByteRangeRaw)}") ở segment ${short(line.value)}`,
            'bad-range',
          );
        }
        rangeCursor.set(uri, byteRange.offset + byteRange.length);
      }

      const key = chooseKey(activeKeys);
      segments.push({
        index: segments.length,
        mediaSequence: mediaSequence + segments.length,
        uri,
        duration: pendingDuration,
        title: pendingTitle,
        byteRange,
        key: key && key.method !== 'NONE' ? key : null,
        map: currentMap,
        discontinuity: pendingDiscontinuity,
        gap: pendingGap,
      });

      pendingDuration = null;
      pendingTitle = null;
      pendingByteRangeRaw = null;
      pendingDiscontinuity = false;
      pendingGap = false;
      continue;
    }

    switch (line.tag) {
      case 'EXT-X-VERSION':
        version = toInt(line.value, 1);
        break;

      case 'EXT-X-TARGETDURATION':
        targetDuration = toFloat(line.value, 0);
        break;

      case 'EXT-X-MEDIA-SEQUENCE':
        // Phải đến trước segment đầu tiên theo RFC; nếu không thì số thứ tự đã tính
        // cho các segment phía trên sẽ sai, nhưng ta không sửa lại vì đó là playlist hỏng.
        mediaSequence = toInt(line.value, 0);
        break;

      case 'EXT-X-PLAYLIST-TYPE': {
        const t = line.value.trim().toUpperCase();
        if (t === 'VOD' || t === 'EVENT') playlistType = t;
        break;
      }

      case 'EXT-X-ENDLIST':
        hasEndList = true;
        break;

      case 'EXTINF': {
        const comma = line.value.indexOf(',');
        const durationText = comma >= 0 ? line.value.slice(0, comma) : line.value;
        const title = comma >= 0 ? line.value.slice(comma + 1).trim() : '';
        pendingDuration = toFloat(durationText, 0);
        pendingTitle = title || null;
        break;
      }

      case 'EXT-X-BYTERANGE':
        // Chưa resolve được ngay vì offset ngầm phụ thuộc URI nằm ở dòng sau.
        pendingByteRangeRaw = line.value;
        break;

      case 'EXT-X-DISCONTINUITY':
        pendingDiscontinuity = true;
        break;

      case 'EXT-X-GAP':
        pendingGap = true;
        break;

      case 'EXT-X-KEY': {
        const key = parseKey(line.value, baseUrl);
        if (key.method === 'NONE') {
          // METHOD=NONE gỡ mã hóa cho mọi KEYFORMAT, không riêng cái nào.
          activeKeys.clear();
        } else {
          activeKeys.set(key.keyFormat, key);
        }
        break;
      }

      case 'EXT-X-MAP': {
        const attrs = parseAttributes(line.value);
        const uriAttr = attrs.get('URI');
        if (!uriAttr) break;
        const rangeAttr = attrs.get('BYTERANGE');
        currentMap = {
          uri: resolveUri(uriAttr, baseUrl),
          // Với EXT-X-MAP không có sub-range trước đó, offset ngầm là 0.
          byteRange: rangeAttr ? parseByteRange(rangeAttr, 0) : null,
        };
        // fMP4 một file: init section và mọi segment nằm chung một URI, nên segment
        // đầu tiên dùng offset ngầm phải nối tiếp ngay sau init section. Không ghi nhận
        // ở đây thì con trỏ trống trơn và segment đó rơi vào đúng ca hỏng phía trên.
        if (currentMap.byteRange) {
          rangeCursor.set(
            currentMap.uri,
            currentMap.byteRange.offset + currentMap.byteRange.length,
          );
        }
        const seen = initSegments.some(
          (m) =>
            m.uri === currentMap!.uri &&
            m.byteRange?.offset === currentMap!.byteRange?.offset &&
            m.byteRange?.length === currentMap!.byteRange?.length,
        );
        if (!seen) initSegments.push(currentMap);
        break;
      }

      default:
        break;
    }
  }

  if (segments.length === 0) {
    throw new PlaylistError('Playlist không chứa segment nào', 'no-segments');
  }

  const totalDuration = segments.reduce((sum, s) => sum + s.duration, 0);
  const encryption = [
    ...new Set<EncryptionMethod>(segments.map((s) => s.key?.method ?? 'NONE')),
  ];

  return {
    kind: 'media',
    version,
    targetDuration,
    mediaSequence,
    // Danh sách thiếu EXT-X-ENDLIST là danh sách còn đang mọc. EVENT cũng vậy —
    // nó chỉ hứa sẽ không xóa segment cũ, chứ không hứa đã ngừng thêm segment mới.
    hasEndList,
    isLive: !hasEndList && playlistType !== 'VOD',
    playlistType,
    segments,
    totalDuration,
    initSegments,
    hasDiscontinuity: segments.some((s) => s.discontinuity),
    container: detectContainer(segments[0]!.uri, initSegments.length > 0),
    encryption,
  };
}

export function parsePlaylist(text: string, baseUrl: string): Playlist {
  if (!text.trim()) throw new PlaylistError('Playlist rỗng', 'empty');
  if (!looksLikeM3u8(text)) {
    throw new PlaylistError(
      'Nội dung tải về không phải playlist M3U8 (thiếu #EXTM3U) — nhiều khả năng server trả về trang HTML',
      'not-m3u8',
    );
  }

  const isMaster = /^#EXT-X-STREAM-INF[:\s]/m.test(text);
  return isMaster ? parseMaster(text, baseUrl) : parseMedia(text, baseUrl);
}

/* ---------- Chọn chất lượng ---------- */

export type QualityPreference = 'best' | 'worst' | { maxHeight: number };

function heightOf(v: Variant): number {
  return v.resolution?.height ?? 0;
}

/** Bandwidth là tiêu chí chính; chiều cao chỉ phá thế hòa khi hai variant khai bằng nhau. */
function betterThan(a: Variant, b: Variant): boolean {
  if (a.bandwidth !== b.bandwidth) return a.bandwidth > b.bandwidth;
  return heightOf(a) > heightOf(b);
}

export function pickVariant(master: MasterPlaylist, pref: QualityPreference = 'best'): Variant | null {
  if (master.variants.length === 0) return null;

  if (pref === 'best' || pref === 'worst') {
    let chosen = master.variants[0]!;
    for (const v of master.variants) {
      const better = pref === 'best' ? betterThan(v, chosen) : betterThan(chosen, v);
      if (better) chosen = v;
    }
    return chosen;
  }

  const fits = master.variants.filter(
    (v) => v.resolution !== null && v.resolution.height <= pref.maxHeight,
  );
  if (fits.length > 0) {
    let chosen = fits[0]!;
    for (const v of fits) if (betterThan(v, chosen)) chosen = v;
    return chosen;
  }

  // Không variant nào đủ nhỏ: đưa cái thấp nhất thay vì bỏ cuộc, vì người dùng đặt
  // trần chiều cao là để tiết kiệm băng thông chứ không phải để hủy lượt tải.
  let smallest = master.variants[0]!;
  for (const v of master.variants) if (betterThan(smallest, v)) smallest = v;
  return smallest;
}

/**
 * Rendition tiếng đi kèm một variant, hoặc null khi tiếng đã ghép sẵn trong variant.
 * Nhóm AUDIO mà mọi rendition đều không có URI chính là dấu hiệu "đã ghép sẵn".
 */
export function pickAudioRendition(master: MasterPlaylist, variant: Variant): Rendition | null {
  if (!variant.audioGroup) return null;

  const group = master.renditions.filter(
    (r) => r.type === 'AUDIO' && r.groupId === variant.audioGroup && r.uri !== null,
  );
  if (group.length === 0) return null;

  return group.find((r) => r.isDefault) ?? group.find((r) => r.autoselect) ?? group[0]!;
}
