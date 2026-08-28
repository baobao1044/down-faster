/**
 * Định dạng số liệu cho người đọc.
 *
 * Mọi nhãn và đơn vị đều đi qua `t()` thay vì cứng trong mã: tiếng Anh và tiếng
 * Việt khác nhau ở cả đơn vị thời gian (en "2m 5s" / vi "2 phút 5 giây") lẫn dấu
 * thay số liệu chưa biết, nên để bảng chuỗi lo phần chữ. Module này chỉ chạy trong
 * UI của extension (manager/popup), nơi `chrome.i18n` có sẵn; trong Node `t()` tự
 * rơi về key nên test vẫn chạy được qua `useMessageTable`.
 */

import { t } from '../shared/i18n';

/** Key đơn vị dung lượng, từ byte lên terabyte, đúng thứ tự `bytes()` dùng. */
export const UNIT_KEYS = [
  'unit_byte',
  'unit_kilobyte',
  'unit_megabyte',
  'unit_gigabyte',
  'unit_terabyte',
] as const;

/** Key khoảng thời gian, từ giây lên giờ. */
export const DURATION_KEYS = ['duration_seconds', 'duration_minutes', 'duration_hours'] as const;

export function bytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return t('common_unknown');
  let v = value;
  let i = 0;
  while (v >= 1024 && i < UNIT_KEYS.length - 1) {
    v /= 1024;
    i += 1;
  }
  const label = t(UNIT_KEYS[i]!);
  // Dưới 1024 thì giữ nguyên số (có thể lẻ khi là tốc độ), còn trên thì làm tròn
  // một chữ số khi nhỏ hơn 10 để "1.0 KB" không thành "1 KB" mất độ tin cậy.
  return `${i === 0 ? v : v.toFixed(v < 10 ? 1 : 0)} ${label}`;
}

export function speed(bytesPerSecond: number): string {
  return bytesPerSecond > 0 ? t('unit_per_second', { value: bytes(bytesPerSecond) }) : t('common_unknown');
}

export function eta(received: number, total: number | null, bytesPerSecond: number): string {
  if (!total || bytesPerSecond <= 0) return t('common_unknown');
  const left = Math.max(0, total - received);
  const seconds = Math.round(left / bytesPerSecond);
  if (seconds < 60) return t('duration_seconds', { seconds });
  if (seconds < 3600) return t('duration_minutes', { minutes: Math.floor(seconds / 60), seconds: seconds % 60 });
  return t('duration_hours', { hours: Math.floor(seconds / 3600), minutes: Math.floor((seconds % 3600) / 60) });
}

/**
 * Nhãn trạng thái cho người đọc. Dùng key ghép `state_${state}` giống như
 * `a11y.ts`, nên engine thêm trạng thái nào cũng tự có nhãn miễn bảng chuỗi đủ.
 * Thiếu key thì rơi về chính cái `state` — giữ nguyên dự phòng cũ của `STATE_LABEL`.
 */
export function stateLabel(state: string): string {
  return t(`state_${state}`, undefined, state);
}
