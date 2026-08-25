/** Giao thức nhắn tin giữa orchestrator và các worker. */

/* ---------- Writer worker ---------- */

export type WriterCommand =
  | { type: 'open'; fileName: string; size: number }
  | { type: 'attach' }
  | { type: 'flush' }
  | { type: 'close' };

export type WriterEvent =
  | { type: 'ready' }
  | { type: 'flushed' }
  | { type: 'closed'; size: number }
  | { type: 'error'; message: string };

/** Gửi qua MessagePort riêng của từng fetch worker, không qua luồng chính. */
export interface WriteRequest {
  offset: number;
  buffer: ArrayBuffer;
}

/** Biên nhận để fetch worker biết đĩa đã tiêu thụ tới đâu mà giảm tốc. */
export interface WriteAck {
  written: number;
}

/* ---------- Fetch worker ---------- */

export type FetchCommand =
  | {
      type: 'init';
      highWaterMark: number;
      /**
       * Có đang bị giới hạn tốc độ hay không.
       *
       * Đoán sai theo chiều "tưởng không giới hạn" là thủng hạn mức, nên mặc
       * định của client là coi như có; cờ này chỉ dùng để tắt hẳn cho nhanh.
       */
      limited?: boolean;
    }
  | {
      type: 'piece';
      pieceIndex: number;
      url: string;
      start: number;
      end: number;
      headers?: Record<string, string>;
    }
  /** Hạn mức tốc độ được cấp; `bytes < 0` nghĩa là bỏ giới hạn. */
  | { type: 'quota'; bytes: number }
  | { type: 'abort' };

export type FetchEvent =
  | { type: 'progress'; pieceIndex: number; bytes: number }
  | { type: 'done'; pieceIndex: number; bytes: number }
  | {
      type: 'failed';
      pieceIndex: number;
      message: string;
      retryable: boolean;
      /** Mã HTTP nếu lỗi đến từ phản hồi, để bộ điều khiển thích nghi đọc áp lực. */
      status?: number | null;
      /** Giá trị Retry-After đã quy ra mili giây, nếu server có gửi. */
      retryAfterMs?: number | null;
    }
  /** Xin thêm hạn mức tốc độ; host trả lời bằng lệnh `quota`. */
  | { type: 'quota-ask' }
  | { type: 'aborted' };
