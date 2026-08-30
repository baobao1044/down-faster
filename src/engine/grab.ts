/**
 * Logic thuần cho Link Grabber: phân loại URL, bỏ trùng, dựng kết quả dò.
 *
 * Module này không có network, không DOM, không API trình duyệt — chỉ pure logic.
 * Tách riêng để `test/grab.test.ts` import được mà không kéo theo `platform/api`
 * (vốn đụng globalThis.browser ở mức module và ném trong Node).
 */

import { classifyMediaUrl } from './hls';
import type { ProbeResult } from './types';
import type { GrabbedItem } from '../shared/rpc';
import type { MediaProbe, VariantSummary } from './hls';

/** Số URL dò cùng lúc — quá cao sẽ bị server 429. */
export const GRAB_CONCURRENCY = 4;

/**
 * Phân loại một URL thành loại nội dung để grab() biết gọi probe nào.
 *
 * - 'media' nếu URL là playlist HLS (.m3u8, application/vnd.apple.mpegurl).
 * - 'unsupported' nếu là DASH (.mpd) — chưa làm.
 * - 'file' nếu không nhận ra — tải như file thường.
 */
export function classifyGrabUrl(url: string): 'file' | 'media' | 'unsupported' {
  const kind = classifyMediaUrl(url);
  if (kind === 'hls') return 'media';
  if (kind === 'dash') return 'unsupported';
  return 'file';
}

/**
 * Bỏ trùng URL: chuẩn hoá (lowercase host, bỏ fragment, bỏ dấu / cuối) rồi giữ
 * bản đầu tiên gặp. Trả danh sách giữ thứ tự gốc.
 */
export function dedupUrls(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of urls) {
    const u = raw.trim();
    if (!u) continue;
    try {
      const parsed = new URL(u);
      // Chuẩn hoá: lowercase scheme+host, bỏ fragment, bỏ / cuối path.
      let key = `${parsed.protocol}//${parsed.host.toLowerCase()}${parsed.pathname}${parsed.search}`;
      key = key.replace(/\/$/, '') || key;
      if (!seen.has(key)) {
        seen.add(key);
        out.push(u);
      }
    } catch {
      // URL hỏng: giữ nguyên (grab() sẽ báo lỗi khi probe).
      if (!seen.has(u)) {
        seen.add(u);
        out.push(u);
      }
    }
  }
  return out;
}

/** Dựng GrabbedItem cho file thường từ kết quả probe. */
export function makeFileItem(url: string, probe: ProbeResult): GrabbedItem {
  return {
    url: probe.finalUrl || url,
    filename: probe.filename,
    size: probe.size,
    kind: 'file',
  };
}

/** Dựng GrabbedItem cho HLS từ kết quả probeMedia. */
export function makeMediaItem(url: string, probe: MediaProbe): GrabbedItem {
  const variants: VariantSummary[] | undefined =
    probe.variants.length > 0 ? probe.variants : undefined;
  return {
    url,
    filename: probe.filename,
    size: null, // HLS không biết tổng kích thước trước khi tải hết segment
    kind: 'media',
    variants,
  };
}

/** Dựng GrabbedItem lỗi khi probe thất bại. */
export function makeErrorItem(url: string, error: string): GrabbedItem {
  return {
    url,
    filename: '',
    size: null,
    kind: 'unsupported',
    error,
  };
}
