import { api } from '../platform/api';
import { DEFAULT_MAX_CONCURRENT } from '../engine/queue';
import { normalizeWindows, type ScheduleWindow } from '../engine/schedule';
import type { RefererMode } from '../engine/adaptive/headers';
import type { DownloadOptions } from '../engine/types';

export interface Settings {
  /**
   * Tự tăng tốc mọi lượt tải mà không cần hỏi. Đây là chế độ mặc định: người dùng
   * cài extension là để nó chạy, không phải để học cách cấu hình nó.
   */
  autoMode: boolean;
  /** Trần số kết nối song song cho mỗi file. Bộ điều khiển thích nghi chạy dưới trần này. */
  connections: number;
  /**
   * Dưới ngưỡng này thì để trình duyệt tự lo. Chia luồng một file vài trăm KB
   * không nhanh hơn được bao nhiêu mà lại thêm một chỗ có thể hỏng.
   */
  minInterceptSize: number;
  maxRetries: number;

  /* ---------- Thích nghi ---------- */

  /** Tự dò số kết nối tối ưu thay vì luôn mở đủ trần. */
  adaptiveConnections: boolean;
  /** Vẫn tải khi server không cho biết kích thước, thay vì từ chối. */
  allowStreaming: boolean;
  /** Mức phát lại Referer cho những link chỉ sống khi có đúng nguồn dẫn. */
  replayHeaders: RefererMode;
  /** Thử tìm và dùng nhiều nguồn cho cùng một file. */
  mirrorSearch: boolean;

  /* ---------- Điều tiết ---------- */

  /** Byte mỗi giây, 0 nghĩa là không giới hạn. */
  speedLimit: number;
  /** Số file được tải cùng lúc; phần còn lại xếp hàng. */
  maxConcurrent: number;
  scheduleEnabled: boolean;
  scheduleWindows: ScheduleWindow[];

  /* ---------- Giao diện ---------- */

  /** Dò video trong trang để đề nghị tải. */
  detectMedia: boolean;
  onboarded: boolean;
  firstRunNoticeShown: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  autoMode: true,
  connections: 8,
  minInterceptSize: 5 * 1024 * 1024,
  maxRetries: 5,

  adaptiveConnections: true,
  allowStreaming: true,
  replayHeaders: 'auto',
  mirrorSearch: false,

  speedLimit: 0,
  maxConcurrent: DEFAULT_MAX_CONCURRENT,
  scheduleEnabled: false,
  scheduleWindows: [],

  detectMedia: true,
  onboarded: false,
  firstRunNoticeShown: false,
};

const KEY = 'settings';

export async function loadSettings(): Promise<Settings> {
  try {
    const stored = await api.storage.local.get(KEY);
    const merged = {
      ...DEFAULT_SETTINGS,
      ...(stored?.[KEY] as Partial<Settings> | undefined),
    };
    // Phép spread không lọc được rác do bản cũ ghi hoặc người dùng sửa tay, mà một
    // khung giờ hỏng nghĩa là người dùng ngồi chờ mãi không thấy lượt tải nào chạy.
    merged.scheduleWindows = normalizeWindows(merged.scheduleWindows);
    return merged;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await loadSettings()), ...patch };
  if (patch.scheduleWindows !== undefined) {
    next.scheduleWindows = normalizeWindows(patch.scheduleWindows);
  }
  await api.storage.local.set({ [KEY]: next });
  return next;
}

/**
 * Phần cài đặt mà một lượt tải cần biết.
 *
 * Tách ra để engine không phải mang theo cả `Settings` — nó không có việc gì với
 * `onboarded` hay `detectMedia`, và trộn lẫn hai thứ khiến việc test một lượt tải
 * phải dựng cả một object cài đặt giả.
 */
export function toDownloadOptions(settings: Settings): Partial<DownloadOptions> {
  return {
    connections: settings.connections,
    maxRetries: settings.maxRetries,
    minAccelerateSize: settings.minInterceptSize,
    adaptiveConnections: settings.adaptiveConnections,
    allowStreaming: settings.allowStreaming,
    replayHeaders: settings.replayHeaders,
  };
}
