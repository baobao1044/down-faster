import type { Settings } from '../shared/settings';
import type { PersistenceStore } from './persistence';
import type { HeaderRuleSpec } from './adaptive/headers';

/**
 * Cầu nối giữa engine và các API của trình duyệt.
 *
 * Tồn tại vì offscreen document của Chromium bị giới hạn nghiêm ngặt: nó chỉ chắc
 * chắn dùng được `chrome.runtime`, còn `downloads`, `storage`, `notifications`,
 * `action` hay `declarativeNetRequest` thì không. Engine vì thế không gọi thẳng
 * API nào cả — nó chỉ yêu cầu, và bên nào có quyền sẽ thực thi. Trên Firefox
 * engine sống ngay trong background nên cầu nối chỉ là lời gọi hàm trực tiếp.
 */
export interface HostBridge {
  /** Giao file đã tải xong cho trình duyệt lưu xuống đĩa. */
  saveFile(request: { taskId: string; blobUrl: string; filename: string }): Promise<void>;
  /** Trả lượt tải về cho trình duyệt tự lo, dùng khi engine bỏ cuộc. */
  handBack(request: { url: string; filename?: string }): Promise<void>;
  /** Số lượt đang tải, để hiển thị lên biểu tượng extension. */
  setActiveCount(count: number): void;
  loadSettings(): Promise<Settings>;
  /** Nơi TaskPersistence chốt sổ tiến độ. */
  store: PersistenceStore;
  /** Báo kết quả cho người dùng; im lặng bỏ qua nếu họ đã tắt thông báo. */
  notify(request: { id: string; title: string; message: string }): void;
  /**
   * Cài luật phát lại header mà `fetch` không cho đặt.
   *
   * Trả về true nếu luật đã vào; false nghĩa là trình duyệt từ chối và bên gọi
   * phải coi như không có Referer chứ đừng chờ đợi gì.
   */
  applyHeaderRules(request: { add: HeaderRuleSpec[]; removeIds: number[] }): Promise<boolean>;
}
