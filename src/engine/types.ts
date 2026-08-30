/** Kiểu dữ liệu dùng chung giữa orchestrator, worker và UI. */

import type { RefererMode } from './adaptive/headers';

export type DownloadState =
  | 'queued'
  | 'probing'
  | 'downloading'
  | 'paused'
  | 'assembling'
  | 'completed'
  | 'failed'
  | 'canceled';

/** Kết quả thăm dò server trước khi quyết định chia luồng. */
export interface ProbeResult {
  /** URL sau khi đã đi hết chuỗi redirect. Các piece phải dùng URL này. */
  finalUrl: string;
  /** null khi server không trả Content-Length (chunked/stream). */
  size: number | null;
  /** Server có chấp nhận header Range hay không. */
  acceptRanges: boolean;
  filename: string;
  mimeType: string | null;
  /** Dùng để phát hiện file đổi giữa chừng khi resume. */
  etag: string | null;
  lastModified: string | null;
}

export type PieceState = 'pending' | 'active' | 'done' | 'failed';

/** Một khoảng byte của file. Cả start và end đều inclusive, đúng ngữ nghĩa HTTP Range. */
export interface Piece {
  index: number;
  start: number;
  end: number;
  /** Số byte đã ghi thành công. Khi resume, piece bắt đầu lại từ start + received. */
  received: number;
  state: PieceState;
  attempts: number;
}

export interface DownloadOptions {
  /** Số kết nối song song tối đa cho một file. */
  connections: number;
  /** Số lần thử lại cho mỗi piece trước khi bỏ cuộc. */
  maxRetries: number;
  /** Giới hạn byte đang chờ ghi, để mạng nhanh không làm phình RAM. */
  writeHighWaterMark: number;
  /** Lượt tải tự động nhỏ hơn mức này thì trả lại cho trình duyệt. */
  minAccelerateSize: number;
  /** Tự dò số kết nối tối ưu thay vì luôn chạy hết trần `connections`. */
  adaptiveConnections: boolean;
  /** Sàn của bộ điều khiển thích nghi; không bao giờ tụt xuống dưới mức này. */
  minConnections: number;
  /** Vẫn tải khi server giấu kích thước, thay vì từ chối ngay. */
  allowStreaming: boolean;
  /** Các URL thay thế cho cùng một file, nếu biết. */
  mirrors?: string[];
  /** Mức phát lại Referer khi server đòi đúng nguồn dẫn. */
  replayHeaders: RefererMode;
}

export const DEFAULT_OPTIONS: DownloadOptions = {
  connections: 64,
  maxRetries: 5,
  writeHighWaterMark: 8 * 1024 * 1024,
  minAccelerateSize: 5 * 1024 * 1024,
  adaptiveConnections: true,
  minConnections: 1,
  allowStreaming: true,
  replayHeaders: 'auto',
};

/** Lượt tải này do người dùng tự thêm, hay do extension giành lấy từ trình duyệt. */
export type TaskSource = 'manual' | 'auto';

export interface DownloadTask {
  id: string;
  source: TaskSource;
  url: string;
  finalUrl: string;
  filename: string;
  size: number | null;
  state: DownloadState;
  /** Tổng số byte đã nhận, cộng dồn từ mọi piece. */
  received: number;
  pieces: Piece[];
  error: string | null;
  createdAt: number;
  /** Tốc độ tức thời, byte mỗi giây, do orchestrator ước lượng. */
  speed: number;
  acceptRanges: boolean;
  etag: string | null;
  lastModified: string | null;
  /** Cần cho việc khôi phục: dựng lại blob đúng kiểu sau khi trình duyệt khởi động lại. */
  mimeType: string | null;
}

export interface Progress {
  id: string;
  received: number;
  size: number | null;
  speed: number;
  state: DownloadState;
  /** Số kết nối đang thực sự chạy, hữu ích để chẩn đoán. */
  activeConnections: number;
}
