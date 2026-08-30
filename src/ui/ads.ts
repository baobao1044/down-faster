/**
 * Ô quảng cáo nhỏ cho popup và trang quản lý.
 *
 * Hai nguồn creative:
 * - House ad (mặc định): nội dung cứng do maintainer đặt, không network, chạy
 *   ngay ở 0 user. Hiện link star/sponsor GitHub.
 * - Network ad (sẵn sàng nhưng TẮT): fetch JSON creative từ ad network (vd
 *   EthicalAds) khi đủ traffic + được duyệt. Bật bằng cách đổi DEFAULT_ADS_CONFIG.
 *
 * An toàn MV3: CSP `script-src 'self'` cấm script ngoài, nên creative được fetch
 * dạng JSON rồi tự render bằng el()/textContent — không bao giờ innerHTML. URL
 * link chỉ chấp nhận http/https (chặn javascript:, data:).
 */

import { t } from '../shared/i18n';
import { warn } from '../shared/log';
import { clear, el, setHidden } from './dom';

export interface AdCreative {
  /** Tên nhà tài trợ / nguồn — hiện ở dòng "Tài trợ bởi {name}". */
  sponsor: string;
  /** Nội dung chính của quảng cáo. */
  text: string;
  /** Ảnh kèm (tùy chọn); phải là URL http/https. */
  imageUrl?: string;
  /** URL đích khi click; phải là http/https. */
  linkUrl: string;
}

export interface AdsConfig {
  /** Bật quảng cáo từ network ngoài. Mặc định TẮT — chỉ bật khi đủ traffic + được duyệt. */
  networkEnabled: boolean;
  /** Endpoint trả JSON creative khi networkEnabled = true. */
  networkEndpoint?: string;
}

/**
 * Cấu hình mặc định: chỉ house ad. Đổi hằng số này để bật network trong bản sau
 * — không có settings UI vì đây là quyết định của maintainer, không phải người dùng.
 */
export const DEFAULT_ADS_CONFIG: AdsConfig = {
  networkEnabled: false,
  networkEndpoint: undefined,
};

const REPO_URL = 'https://github.com/baobao1044/down-faster';

/**
 * Chuẩn hoá JSON thô từ network thành creative, hoặc null nếu không hợp lệ.
 *
 * Kiểm tra: sponsor + text + linkUrl phải là chuỗi không rỗng; linkUrl phải là
 * http/https (chặn javascript:, data: và lược đồ lạ); imageUrl nếu có cũng
 * phải http/https, hỏng thì bỏ (vẫn hiện text).
 */
export function normalizeCreative(raw: unknown): AdCreative | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;

  const sponsor = typeof r.sponsor === 'string' ? r.sponsor.trim() : '';
  const text = typeof r.text === 'string' ? r.text.trim() : '';
  const linkUrl = typeof r.linkUrl === 'string' ? r.linkUrl.trim() : '';
  if (!sponsor || !text || !linkUrl) return null;

  let link: URL;
  try {
    link = new URL(linkUrl);
  } catch {
    return null;
  }
  if (link.protocol !== 'http:' && link.protocol !== 'https:') return null;

  let imageUrl: string | undefined;
  const rawImage = typeof r.imageUrl === 'string' ? r.imageUrl.trim() : '';
  if (rawImage) {
    try {
      const img = new URL(rawImage);
      if (img.protocol === 'http:' || img.protocol === 'https:') imageUrl = rawImage;
    } catch {
      // URL ảnh hỏng — bỏ, vẫn hiện creative text.
    }
  }

  return { sponsor, text, linkUrl, imageUrl };
}

/** Chọn nguồn ads: network khi bật + có endpoint, còn lại là house. */
export function pickProvider(config: AdsConfig): 'house' | 'network' {
  return config.networkEnabled && !!config.networkEndpoint ? 'network' : 'house';
}

/** Creative house mặc định — không network, chạy ngay ở 0 user. */
export function buildHouseFallback(): AdCreative {
  return {
    sponsor: t('ext_name'),
    text: t('ad_house_text'),
    linkUrl: REPO_URL,
  };
}

/**
 * Lấy creative để hiển thị. House ad khi network TẮT; network khi BẬT, rơi về
 * house nếu fetch thất bại hoặc creative không hợp lệ.
 *
 * `fetchImpl` tiêm được để test nhánh network không cần network thật — giống
 * cách `probe()` nhận `fetchImpl` trong `src/engine/probe.ts`.
 */
export async function resolveCreative(
  config: AdsConfig = DEFAULT_ADS_CONFIG,
  fetchImpl?: typeof fetch,
): Promise<AdCreative | null> {
  if (pickProvider(config) !== 'network') return buildHouseFallback();

  const f = fetchImpl ?? fetch;
  try {
    // credentials: 'omit' — không gửi cookie tới ad endpoint, bảo vệ privacy.
    const res = await f(config.networkEndpoint!, {
      method: 'GET',
      credentials: 'omit',
      cache: 'no-store',
    });
    if (!res.ok) return buildHouseFallback();
    return normalizeCreative(await res.json()) ?? buildHouseFallback();
  } catch {
    return buildHouseFallback();
  }
}

/**
 * Dựng ô quảng cáo vào slot. Creative null → ẩn slot. Không bao giờ ném:
 * ads không được làm hỏng UI tải.
 */
export function renderAdSlot(slot: HTMLElement, creative: AdCreative | null): void {
  if (!creative) {
    clear(slot);
    setHidden(slot, true);
    return;
  }

  clear(slot);
  slot.append(
    // Nhãn "Quảng cáo" — CWS yêu cầu công bố rõ.
    el('span', { class: 'ad-disclosure', i18n: 'ad_label' }),
    el('a', {
      class: 'ad-content',
      attrs: { href: creative.linkUrl, target: '_blank', rel: 'noopener noreferrer' },
      children: [
        ...(creative.imageUrl
          ? [el('img', { class: 'ad-image', attrs: { src: creative.imageUrl, alt: '' } })]
          : []),
        el('span', { class: 'ad-text', text: creative.text }),
      ],
    }),
    el('span', {
      class: 'ad-sponsor',
      i18n: 'ad_sponsored_by',
      i18nParams: { name: creative.sponsor },
    }),
  );
  setHidden(slot, false);
}

/**
 * Dựng ô quảng cáo an toàn — bọc try/catch để ads không bao giờ làm hỏng UI tải.
 * Slot không có → bỏ qua im lặng (ads là phụ, không phải phần cốt lõi).
 */
export async function mountAds(
  slotId: string,
  config: AdsConfig = DEFAULT_ADS_CONFIG,
): Promise<void> {
  try {
    const slot = document.getElementById(slotId);
    if (!slot) return;
    const creative = await resolveCreative(config);
    renderAdSlot(slot, creative);
  } catch (err) {
    warn('ads', 'không dựng được ô quảng cáo', err);
  }
}
