/**
 * Khóa và giải mã AES-128 cho segment HLS.
 *
 * Chỉ hỗ trợ đúng `METHOD=AES-128` với `KEYFORMAT=identity` — tức AES-128-CBC trên
 * toàn bộ segment. SAMPLE-AES và mọi hệ DRM đều bị chặn ở `assertSupported()` kèm
 * lời giải thích, vì thà nói thẳng là không tải được còn hơn giao ra một file hỏng
 * mà người dùng chỉ phát hiện sau khi chờ xong vài GB.
 *
 * Phần tinh tế nhất nằm ở padding. RFC 8216 quy định segment AES-128 phải có padding
 * PKCS#7, nên đường chính là để `crypto.subtle` tự bóc. Nhưng không ít encoder xuất
 * segment dài đúng bội số 16 mà không padding gì cả; khi đó WebCrypto ném OperationError,
 * hoặc tệ hơn — nếu đuôi dữ liệu tình cờ trông giống padding hợp lệ — nó lặng lẽ cắt
 * mất vài byte. Đường vòng ở `decryptWithoutPadding()` nối thêm một block padding tổng
 * hợp để WebCrypto có cái mà bóc, trả lại đúng nguyên văn plaintext.
 */

import type { KeyInfo, Segment } from './playlist';

export const AES_BLOCK = 16;
/** Một gói MPEG-TS luôn dài đúng 188 byte; dùng làm bất biến để bắt padding giả. */
export const TS_PACKET = 188;

export class UnsupportedEncryptionError extends Error {
  constructor(
    readonly method: string,
    readonly keyFormat: string,
    message: string,
  ) {
    super(message);
    this.name = 'UnsupportedEncryptionError';
  }
}

export class KeyFetchError extends Error {
  constructor(
    readonly uri: string,
    message: string,
  ) {
    super(message);
    this.name = 'KeyFetchError';
  }
}

/* ---------- IV ---------- */

/**
 * IV mặc định: số thứ tự media dạng big-endian 16 byte (RFC 8216 §5.2).
 *
 * Dựng bằng phép chia thay vì DataView.setUint32 vì số thứ tự của một livestream
 * dài ngày hoàn toàn có thể vượt 2^32, và cắt xuống 32 bit sẽ cho IV sai ở đúng
 * những segment cuối — kiểu hỏng chỉ lộ ra khi tải gần xong.
 */
export function ivFromSequence(mediaSequence: number): Uint8Array {
  const iv = new Uint8Array(AES_BLOCK);
  let value = Number.isFinite(mediaSequence) ? Math.max(0, Math.floor(mediaSequence)) : 0;
  for (let i = AES_BLOCK - 1; i >= 0 && value > 0; i -= 1) {
    iv[i] = value % 256;
    value = Math.floor(value / 256);
  }
  return iv;
}

/** IV khai trong EXT-X-KEY luôn thắng số thứ tự — đó là điểm tồn tại của thuộc tính đó. */
export function ivForSegment(segment: Segment): Uint8Array {
  return segment.key?.iv ?? ivFromSequence(segment.mediaSequence);
}

/* ---------- Kiểm tra khả năng hỗ trợ ---------- */

/** KEYFORMAT của các hệ DRM phổ biến; nhận ra để báo đúng tên thay vì "không rõ". */
const DRM_FORMATS: ReadonlyArray<[RegExp, string]> = [
  [/edef8ba9-79d6-4ace-a3c8-27dcd51d21ed/i, 'Widevine'],
  [/9a04f079-9840-4286-ab92-e65be0885f95/i, 'PlayReady'],
  [/com\.apple\.streamingkeydelivery/i, 'FairPlay'],
  [/com\.microsoft\.playready/i, 'PlayReady'],
];

function drmName(key: KeyInfo): string | null {
  for (const [pattern, name] of DRM_FORMATS) {
    if (pattern.test(key.keyFormat)) return name;
  }
  if (key.uri?.startsWith('skd:')) return 'FairPlay';
  return null;
}

/**
 * Ném lỗi có chữ nếu segment dùng thứ ta không giải được.
 *
 * Ba hệ DRM thật thì khóa nằm sau CDM của trình duyệt, extension không với tới được.
 * SAMPLE-AES thì khác — nó khả thi về kỹ thuật nhưng chỉ mã hóa một phần từng mẫu
 * NAL/ADTS, nên muốn giải phải hiểu cấu trúc bitstream, tức lại cần đúng phần
 * demuxer mà cả nhóm HLS này cố tình không viết.
 */
export function assertSupported(key: KeyInfo): void {
  if (key.method === 'NONE') return;

  const drm = drmName(key);
  if (drm) {
    throw new UnsupportedEncryptionError(
      key.rawMethod,
      key.keyFormat,
      `Video được bảo vệ bằng DRM ${drm}. Khóa nằm trong trình duyệt và không thể lấy ra, nên không tải được.`,
    );
  }

  if (key.method === 'SAMPLE-AES') {
    throw new UnsupportedEncryptionError(
      key.rawMethod,
      key.keyFormat,
      'Video mã hóa kiểu SAMPLE-AES — chưa hỗ trợ. Kiểu này chỉ mã hóa một phần từng khung hình nên cần bộ giải mã định dạng riêng.',
    );
  }

  if (key.method !== 'AES-128') {
    throw new UnsupportedEncryptionError(
      key.rawMethod,
      key.keyFormat,
      `Kiểu mã hóa "${key.rawMethod}" chưa được hỗ trợ.`,
    );
  }

  if (key.keyFormat !== 'identity') {
    throw new UnsupportedEncryptionError(
      key.rawMethod,
      key.keyFormat,
      `Khóa dùng định dạng "${key.keyFormat}" thay vì khóa thường — nhiều khả năng là DRM, không tải được.`,
    );
  }

  if (!key.uri) {
    throw new UnsupportedEncryptionError(
      key.rawMethod,
      key.keyFormat,
      'Playlist khai là có mã hóa nhưng không cho biết lấy khóa ở đâu.',
    );
  }
}

/* ---------- Đọc khóa ---------- */

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function base64ToBytes(text: string): Uint8Array | null {
  try {
    // base64url xuất hiện trong không ít data: URI; atob chỉ hiểu base64 thường.
    const normalized = text.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(normalized);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/**
 * Rút 16 byte khóa từ `data:` URI mà không gọi mạng.
 *
 * Một số packager nhúng thẳng khóa vào playlist. Đây là đường duy nhất ta chấp nhận
 * URI khác http(s), và nó an toàn đúng vì không có request nào rời khỏi máy.
 */
export function keyFromDataUri(uri: string): Uint8Array | null {
  if (!uri.startsWith('data:')) return null;

  const comma = uri.indexOf(',');
  if (comma < 0) return null;

  const meta = uri.slice(5, comma).toLowerCase();
  const payload = uri.slice(comma + 1);

  let bytes: Uint8Array | null;
  if (meta.includes(';base64')) {
    bytes = base64ToBytes(payload);
  } else {
    let decoded: string;
    try {
      decoded = decodeURIComponent(payload);
    } catch {
      decoded = payload;
    }
    // Khóa viết dạng hex là quy ước phổ biến thứ hai sau base64.
    bytes = hexToBytes(decoded.trim()) ?? latin1ToBytes(decoded);
  }

  return bytes && bytes.length === AES_BLOCK ? bytes : null;
}

function latin1ToBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

export interface KeyStoreOptions {
  /** Thay được để test; mặc định fetch kèm cookie để lấy được khóa sau đăng nhập. */
  fetchKey?: (uri: string, signal?: AbortSignal) => Promise<Uint8Array>;
}

async function defaultFetchKey(uri: string, signal?: AbortSignal): Promise<Uint8Array> {
  const res = await fetch(uri, {
    method: 'GET',
    // Khóa là 16 byte nhị phân: nếu bị nén rồi trình duyệt tự giải nén thì độ dài sai, nên
    // xin identity và từ chối thẳng nếu server vẫn nén.
    headers: new Headers({ 'Accept-Encoding': 'identity' }),
    credentials: 'include',
    cache: 'no-store',
    redirect: 'follow',
    signal: signal ?? null,
  });
  if (!res.ok) throw new KeyFetchError(uri, `Không lấy được khóa: HTTP ${res.status}`);
  const encoding = res.headers.get('content-encoding');
  if (encoding && encoding.trim().toLowerCase() !== 'identity') {
    throw new KeyFetchError(uri, 'Khóa bị nén trên đường truyền, không lấy nguyên vẹn được');
  }
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Kho khóa dùng chung cho cả một playlist.
 *
 * Một video hai giờ có thể xoay khóa vài chục lần nhưng dùng lại mỗi khóa cho hàng
 * trăm segment. Không cache thì mỗi segment là thêm một request tới key server —
 * đủ để bị chặn vì tần suất, và chậm hơn hẳn.
 */
export class KeyStore {
  private readonly cache = new Map<string, Promise<CryptoKey>>();
  private readonly fetchKey: (uri: string, signal?: AbortSignal) => Promise<Uint8Array>;

  constructor(options: KeyStoreOptions = {}) {
    this.fetchKey = options.fetchKey ?? defaultFetchKey;
  }

  get(key: KeyInfo, signal?: AbortSignal): Promise<CryptoKey> {
    assertSupported(key);
    const uri = key.uri!; // assertSupported đã bảo đảm khác null cho AES-128.

    const cached = this.cache.get(uri);
    if (cached) return cached;

    const pending = this.load(uri, signal).catch((err: unknown) => {
      // Không giữ lời hứa đã hỏng trong cache, nếu không một trục trặc mạng thoáng
      // qua sẽ đóng đinh cả lượt tải cho tới khi người dùng thử lại từ đầu.
      this.cache.delete(uri);
      throw err;
    });
    this.cache.set(uri, pending);
    return pending;
  }

  private async load(uri: string, signal?: AbortSignal): Promise<CryptoKey> {
    const inline = keyFromDataUri(uri);
    const raw = inline ?? (await this.fetchKey(uri, signal));

    if (raw.length !== AES_BLOCK) {
      throw new KeyFetchError(uri, `Khóa dài ${raw.length} byte, cần đúng ${AES_BLOCK} byte`);
    }

    // Cần cả 'encrypt' chứ không riêng 'decrypt': đường vòng cho segment thiếu
    // padding phải tự mã hóa một block để dựng padding tổng hợp.
    return crypto.subtle.importKey('raw', raw as BufferSource, 'AES-CBC', false, [
      'decrypt',
      'encrypt',
    ]);
  }

  clear(): void {
    this.cache.clear();
  }
}

/* ---------- Giải mã ---------- */

function bytesOf(buffer: ArrayBuffer): Uint8Array {
  return new Uint8Array(buffer);
}

export interface DecryptOptions {
  /** Bật bất biến `độ dài % 188 === 0` để bắt ca padding giả của MPEG-TS. */
  expectMpegTs?: boolean;
}

/**
 * Đường chính: để WebCrypto tự bóc PKCS#7, tự lui về đường vòng khi cần.
 *
 * Hai tín hiệu khiến ta chuyển hướng. Rõ ràng nhất là OperationError — ciphertext
 * không có padding hợp lệ. Tinh vi hơn là ca MPEG-TS: decrypt thành công nhưng độ
 * dài không chia hết 188, nghĩa là WebCrypto vừa cắt nhầm mấy byte cuối vì chúng
 * tình cờ trông giống padding. Không có bất biến này thì ca thứ hai đi qua im lặng
 * và để lại một file thiếu đuôi.
 */
export async function decryptSegment(
  data: Uint8Array,
  cryptoKey: CryptoKey,
  iv: Uint8Array,
  options: DecryptOptions = {},
): Promise<Uint8Array> {
  if (data.length === 0) return data;
  if (data.length % AES_BLOCK !== 0) {
    throw new Error(
      `Dữ liệu mã hóa dài ${data.length} byte, không chia hết cho ${AES_BLOCK} — segment tải về bị thiếu`,
    );
  }

  const algo: AesCbcParams = { name: 'AES-CBC', iv: iv as BufferSource };

  let direct: Uint8Array | null = null;
  try {
    direct = bytesOf(await crypto.subtle.decrypt(algo, cryptoKey, data as BufferSource));
  } catch {
    direct = null;
  }

  const directLooksRight =
    direct !== null && (!options.expectMpegTs || direct.length % TS_PACKET === 0);
  if (directLooksRight) return direct!;

  try {
    const patched = await decryptWithoutPadding(data, cryptoKey, iv);
    // Nếu cả hai đường đều không thỏa bất biến TS thì đường chuẩn vẫn đáng tin hơn:
    // ít nhất nó đúng theo RFC, còn bất biến chỉ là phép thử bổ trợ.
    if (!options.expectMpegTs || patched.length % TS_PACKET === 0 || direct === null) {
      return patched;
    }
    return direct;
  } catch (err) {
    if (direct !== null) return direct;
    throw err;
  }
}

/**
 * Giải mã segment KHÔNG có padding.
 *
 * WebCrypto không cho tắt việc bóc padding, nên thay vì chống lại nó ta cho nó thứ
 * nó muốn: nối thêm đúng một block `C_{n+1} = E(0x10×16 XOR C_n)`. Giải mã block đó
 * theo CBC cho ra 16 byte 0x10 — tức một block padding PKCS#7 hoàn chỉnh — nên
 * WebCrypto bóc nó đi và trả lại nguyên văn plaintext, khớp từng byte.
 *
 * `E()` được tính bằng chính `subtle.encrypt` với IV toàn 0: CBC khi đó rút gọn
 * thành ECB cho block đầu tiên, nên 16 byte đầu của kết quả chính là thứ ta cần.
 */
export async function decryptWithoutPadding(
  data: Uint8Array,
  cryptoKey: CryptoKey,
  iv: Uint8Array,
): Promise<Uint8Array> {
  if (data.length === 0) return data;
  if (data.length % AES_BLOCK !== 0) {
    throw new Error(`Dữ liệu mã hóa dài ${data.length} byte, không chia hết cho ${AES_BLOCK}`);
  }

  const lastBlock = data.subarray(data.length - AES_BLOCK);
  const xored = new Uint8Array(AES_BLOCK);
  for (let i = 0; i < AES_BLOCK; i += 1) xored[i] = lastBlock[i]! ^ AES_BLOCK;

  const zeroIv = new Uint8Array(AES_BLOCK);
  const encrypted = bytesOf(
    await crypto.subtle.encrypt(
      { name: 'AES-CBC', iv: zeroIv as BufferSource },
      cryptoKey,
      xored as BufferSource,
    ),
  );
  const synthetic = encrypted.subarray(0, AES_BLOCK);

  const extended = new Uint8Array(data.length + AES_BLOCK);
  extended.set(data, 0);
  extended.set(synthetic, data.length);

  const algo: AesCbcParams = { name: 'AES-CBC', iv: iv as BufferSource };
  return bytesOf(await crypto.subtle.decrypt(algo, cryptoKey, extended as BufferSource));
}
