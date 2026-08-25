import type { ProbeResult } from './types';
import { resolveFilename } from './filename';

export interface ProbeOptions {
  headers?: Record<string, string>;
  signal?: AbortSignal;
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
  const headers = new Headers(opts.headers ?? {});
  headers.set('Range', 'bytes=0-0');

  const res = await fetch(url, {
    method: 'GET',
    headers,
    redirect: 'follow',
    // Gửi kèm cookie để tải được file sau đăng nhập, thứ mà aria2 ngoài trình duyệt không có.
    credentials: 'include',
    cache: 'no-store',
    signal: opts.signal ?? null,
  });

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
    // 200 nghĩa là server phớt lờ Range: chỉ còn đường tải một luồng.
    const size = parseContentLength(res.headers.get('content-length'));
    const acceptsRanges = res.headers.get('accept-ranges')?.toLowerCase() === 'bytes';
    return buildResult(res, url, size, acceptsRanges && size !== null);
  }

  throw new Error(`Thăm dò thất bại: HTTP ${res.status} ${res.statusText}`);
}

async function probeWithHead(url: string, opts: ProbeOptions): Promise<ProbeResult> {
  const res = await fetch(url, {
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
