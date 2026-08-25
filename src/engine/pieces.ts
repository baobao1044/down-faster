import type { DownloadOptions, Piece } from './types';

/** Dưới ngưỡng này, chi phí mở thêm kết nối lớn hơn phần thời gian tiết kiệm được. */
const MIN_MULTI_SIZE = 2 * 1024 * 1024;
const MIN_PIECE = 1024 * 1024;
const MAX_PIECE = 16 * 1024 * 1024;

/**
 * Mỗi kết nối được phát nhiều piece thay vì một khoảng liền lớn.
 *
 * Chia tĩnh N phần bằng nhau cho N kết nối nghe hợp lý nhưng hỏng trong thực tế:
 * chỉ cần một kết nối rơi vào node CDN chậm là cả file phải chờ nó, trong khi bảy
 * kết nối kia đã xong và ngồi không. Cắt nhỏ rồi cho worker nào rảnh bốc piece kế
 * tiếp sẽ tự san phẳng chênh lệch tốc độ mà không cần đo đạc gì.
 */
const PIECES_PER_CONNECTION = 4;

export function planPieces(size: number, options: DownloadOptions): Piece[] {
  if (size <= 0) return [];

  const single = (): Piece[] => [
    { index: 0, start: 0, end: size - 1, received: 0, state: 'pending', attempts: 0 },
  ];

  if (size < MIN_MULTI_SIZE || options.connections <= 1) return single();

  const target = Math.ceil(size / (options.connections * PIECES_PER_CONNECTION));
  const pieceSize = Math.min(MAX_PIECE, Math.max(MIN_PIECE, target));

  const pieces: Piece[] = [];
  for (let start = 0, index = 0; start < size; start += pieceSize, index++) {
    pieces.push({
      index,
      start,
      end: Math.min(start + pieceSize, size) - 1,
      received: 0,
      state: 'pending',
      attempts: 0,
    });
  }
  return pieces;
}

/** Byte còn thiếu của một piece, tính từ chỗ lần tải trước dừng lại. */
export function remainingRange(piece: Piece): { start: number; end: number } {
  return { start: piece.start + piece.received, end: piece.end };
}

export function isComplete(pieces: Piece[]): boolean {
  return pieces.every((p) => p.state === 'done');
}

export function totalReceived(pieces: Piece[]): number {
  let sum = 0;
  for (const p of pieces) sum += p.received;
  return sum;
}

/** Piece kế tiếp cho một worker vừa rảnh; null nghĩa là hết việc. */
export function takeNextPending(pieces: Piece[]): Piece | null {
  for (const p of pieces) {
    if (p.state === 'pending') {
      p.state = 'active';
      return p;
    }
  }
  return null;
}

/** Đưa piece thất bại về hàng chờ, hoặc đánh dấu bỏ cuộc khi đã hết lượt thử. */
export function requeue(piece: Piece, maxRetries: number): boolean {
  piece.attempts += 1;
  if (piece.attempts > maxRetries) {
    piece.state = 'failed';
    return false;
  }
  piece.state = 'pending';
  return true;
}
