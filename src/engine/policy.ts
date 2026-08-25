/**
 * Các quyết định của chế độ tự động.
 *
 * Tách riêng khỏi orchestrator và background vì đây là phần dễ sai nhất và cũng
 * đáng test nhất: đoán sai một nước là người dùng mất file hoặc extension rơi vào
 * vòng lặp tự giành lại chính lượt tải nó vừa buông ra.
 */

/**
 * Lý do engine không nên nhận việc này, hoặc null nếu nên nhận.
 *
 * Chế độ tự động chỉ giữ những gì nó thật sự làm nhanh hơn. Giành một file 200 KB
 * hay một server không hỗ trợ `Range` thì chẳng nhanh hơn được bao nhiêu, mà lại
 * thêm một chỗ có thể hỏng.
 */
export function unfitForAcceleration(
  size: number | null,
  acceptRanges: boolean,
  minSize: number,
): string | null {
  if (size === null) return 'server không cho biết kích thước file';
  if (!acceptRanges) return 'server không hỗ trợ tải theo khoảng byte';
  if (size < minSize) return 'file quá nhỏ để cần tăng tốc';
  return null;
}

/** Thông tin tối thiểu về một lượt tải, tách khỏi kiểu dữ liệu riêng của từng trình duyệt. */
export interface InterceptCandidate {
  url: string;
  finalUrl?: string;
  state: string;
  /** -1 khi trình duyệt chưa biết kích thước. */
  fileSize: number;
  byExtensionId?: string;
}

export interface InterceptContext {
  minSize: number;
  /** Id của chính extension này. */
  selfId: string;
  /** URL vừa được trả lại cho trình duyệt, không được giành lần nữa. */
  handedBack: ReadonlySet<string>;
}

/** Lượt tải này có đáng để engine giành lấy không. */
export function shouldIntercept(
  item: InterceptCandidate,
  ctx: InterceptContext,
): boolean {
  const url = item.finalUrl || item.url;

  // Bỏ qua blob: và data:, gồm cả chính file mà engine vừa bàn giao.
  if (!/^https?:/i.test(url)) return false;
  if (item.state !== 'in_progress') return false;

  // Lượt tải do chính extension này tạo ra thì tuyệt đối không đụng vào, nếu
  // không mỗi lần trả việc lại sẽ bị giành lại ngay và lặp vô tận.
  if (item.byExtensionId && item.byExtensionId === ctx.selfId) return false;
  if (ctx.handedBack.has(url) || ctx.handedBack.has(item.url)) return false;

  // fileSize là -1 khi trình duyệt chưa biết; khi đó cứ nhận và để engine tự đo.
  if (item.fileSize > 0 && item.fileSize < ctx.minSize) return false;

  return true;
}
