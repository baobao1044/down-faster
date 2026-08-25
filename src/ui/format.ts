/** Định dạng số liệu cho người đọc. */

export function bytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = value / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

export function speed(bytesPerSecond: number): string {
  return bytesPerSecond > 0 ? `${bytes(bytesPerSecond)}/s` : '—';
}

export function eta(received: number, total: number | null, bytesPerSecond: number): string {
  if (!total || bytesPerSecond <= 0) return '—';
  const left = Math.max(0, total - received);
  const seconds = Math.round(left / bytesPerSecond);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

export const STATE_LABEL: Record<string, string> = {
  queued: 'Đang chờ',
  probing: 'Đang thăm dò',
  downloading: 'Đang tải',
  paused: 'Tạm dừng',
  assembling: 'Đang hoàn tất',
  completed: 'Xong',
  failed: 'Lỗi',
  canceled: 'Đã hủy',
};
