import type { ProbeResult } from './types';
import { resolveFilename } from './filename';

export interface ProbeOptions {
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Thay được để test; mặc định dùng `fetch` toàn cục. */
  fetchImpl?: typeof fetch;
}

/** Đọc tổng kích thước từ `Content-Range: bytes 0-0/12345`. */
function parseTotalFromContentRange(value: string | null): number | null {
  if (!value) return null;
  const m = /bytes\s+\d+-\d+\/(\d+|\*)/i.exec(value);
  if (!m || !m[1] || m[1] === '*') return null;
  const total = Number(m[1]);
  return Number.isFinite(total) ? total : null;
}

function parseContentLength(value: string | null): number | null {
  if (!value) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Nội dung bị nén trên đường truyền làm hỏng phép chia luồng: header Range áp lên
 * byte đã nén, còn fetch lại giải nén trước khi trả cho ta, nên offset lệch hết.
 * Gặp trường hợp này thì lui về một luồng cho an toàn.
 */
function isTransportCompressed(res: Response): boolean {
  const enc = res.headers.get('content-encoding');
  return !!enc && enc.trim().toLowerCase() !== 'identity';
}

function buildResult(res: Response, requestUrl: string, size: number | null, ranges: boolean): ProbeResult {
  return {
    finalUrl: res.url || requestUrl,
    size,
    acceptRanges: ranges && size !== null && size > 0 && !isTransportCompressed(res),
    filename: resolveFilename(res.url || requestUrl, res.headers.get('content-disposition')),
    mimeType: res.headers.get('content-type'),
    etag: res.headers.get('etag'),
    lastModified: res.headers.get('last-modified'),
  };
}

/**
 * Thăm dò server bằng đúng một request `GET` kèm `Range: bytes=0-0`.
 *
 * Cách này nói cho ta biết mọi thứ cần thiết cùng lúc: mã 206 nghĩa là server
 * hiểu Range, `Content-Range` cho tổng kích thước, và các header còn lại cho tên
 * file cùng thẻ định danh phiên bản. HEAD rẻ hơn nhưng không ít CDN chặn hoặc trả
 * thông tin sai lệch với GET, nên ở đây chỉ dùng làm phương án dự phòng.
 */
export async function probe(url: string, opts: ProbeOptions = {}): Promise<ProbeResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const headers = new Headers(opts.headers ?? {});
  headers.set('Range', 'bytes=0-0');

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      headers,
      redirect: 'follow',
      // Gửi kèm cookie để tải được file sau đăng nhập, thứ mà aria2 ngoài trình duyệt không có.
      credentials: 'include',
      cache: 'no-store',
      signal: opts.signal ?? null,
    });
  } catch (err) {
    // Chrome ném TypeError "Failed to fetch" khi một ranged-GET quay về kèm
    // content-encoding gzip (server phớt lờ Range, trả 200 thay vì 206). Trước đây nhánh
    // isTransportCompressed() không bao giờ chạy được vì fetch ném trước khi có Response.
    // Thử lại bằng plain-GET (không Range); nếu vẫn gzip thì chia luồng không thể.
    return probePlainFallback(url, opts, err);
  }

  // Không đọc body: chỉ cần header. Hủy stream để đóng kết nối ngay.
  res.body?.cancel().catch(() => {});

  if (res.status === 206) {
    const total = parseTotalFromContentRange(res.headers.get('content-range'));
    return buildResult(res, url, total, total !== null);
  }

  if (res.status === 416) {
    // Server từ chối khoảng byte, thường vì file rỗng. Hỏi lại bằng HEAD.
    return probeWithHead(url, opts);
  }

  if (res.ok) {
    if (isTransportCompressed(res)) {
      // 200 kèm gzip: server phớt lờ Range VÀ nén đường truyền. Chia luồng không thể vì
      // header Range áp lên byte đã nén còn fetch giải nén trước khi trả, offset lệch hết.
      return probePlainFallback(url, opts, new Error('Phản hồi ranged bị nén trên đường truyền'));
    }
    // 200 không nén nghĩa là server phớt lờ Range: chỉ còn đường tải một luồng.
    const size = parseContentLength(res.headers.get('content-length'));
    const acceptsRanges = res.headers.get('accept-ranges')?.toLowerCase() === 'bytes';
    return buildResult(res, url, size, acceptsRanges && size !== null);
  }

  throw new Error(`Thăm dò thất bại: HTTP ${res.status} ${res.statusText}`);
}

/**
 * Phương án dự phòng khi ranged-GET không dùng được (ném, hoặc trả về bị nén): GET thường
 * KHÔNG kèm Range. Vì không có Range nên không chia luồng được; nếu trả về gzip thì
 * content-length là byte đã nén (không nói lên kích thước file) nên để size null — engine
 * đã biết xử lý size null qua đường streaming (runStream) khi allowStreaming, hoặc trả lại
 * trình duyệt trong auto mode.
 */
async function probePlainFallback(
  url: string,
  opts: ProbeOptions,
  originalErr: unknown,
): Promise<ProbeResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      // KHÔNG có Range: plain-GET để tránh đúng ca Chrome ném với Range+gzip.
      headers: new Headers(opts.headers ?? {}),
      redirect: 'follow',
      credentials: 'include',
      cache: 'no-store',
      signal: opts.signal ?? null,
    });
  } catch (err) {
    // Fallback cũng ném: ném lại lỗi gốc (ranged), thường rõ hơn lỗi opaque "Failed to fetch".
    throw originalErr instanceof Error ? originalErr : err;
  }

  res.body?.cancel().catch(() => {});

  if (isTransportCompressed(res)) {
    // content-length là byte đã nén, không biết kích thước file thật; cấm chia luồng.
    return buildResult(res, url, null, false);
  }

  if (res.ok) {
    // Ranged-GET đã thất bại nên không tin được Range; tải một luồng cho an toàn. Ghi rõ
    // false thay vì tin header accept-ranges của một server vừa phớt lờ Range.
    return buildResult(res, url, parseContentLength(res.headers.get('content-length')), false);
  }

  throw new Error(`Thăm dò thất bại: HTTP ${res.status} ${res.statusText}`);
}

async function probeWithHead(url: string, opts: ProbeOptions): Promise<ProbeResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(url, {
    method: 'HEAD',
    headers: new Headers(opts.headers ?? {}),
    redirect: 'follow',
    credentials: 'include',
    cache: 'no-store',
    signal: opts.signal ?? null,
  });

  if (!res.ok) throw new Error(`Thăm dò thất bại: HTTP ${res.status} ${res.statusText}`);

  const size = parseContentLength(res.headers.get('content-length'));
  const acceptsRanges = res.headers.get('accept-ranges')?.toLowerCase() === 'bytes';
  return buildResult(res, url, size, acceptsRanges && size !== null);
}
