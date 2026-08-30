import type { DownloadTask, TaskSource } from '../engine/types';
import type { Priority, QueueEntryState } from '../engine/queue';
import type { MediaProbe, VariantSummary } from '../engine/hls';
import type { HeaderRuleSpec } from '../engine/adaptive/headers';
import type { Settings } from './settings';

/** Loại việc: file thường tải theo khoảng byte, hay luồng media ghép từ segment. */
export type TaskKind = 'file' | 'media';

/** Một mục do Link Grabber dò ra: một URL, loại nội dung, và metadata để chọn tải. */
export interface GrabbedItem {
  url: string;
  filename: string;
  /** null khi không biết (HLS, streaming, không Content-Length). */
  size: number | null;
  kind: 'file' | 'media' | 'unsupported';
  /** Lý do không hỗ trợ, hiện khi kind = 'unsupported'. */
  error?: string;
  /** Chỉ cho kind = 'media': các biến thể chất lượng (HLS master playlist). */
  variants?: VariantSummary[];
}

/** Lệnh gửi tới engine host (offscreen trên Chromium, background trên Firefox). */
export type EngineRequest =
  | {
      type: 'engine:add';
      url: string;
      filename?: string;
      source?: TaskSource;
      /** Trang đã dẫn tới file này, cần khi server đòi đúng Referer. */
      pageUrl?: string;
      priority?: Priority;
      /** Các URL khác chứa cùng một file; engine tự chọn nguồn nhanh nhất. */
      mirrors?: string[];
    }
  /** Thêm một luồng HLS/DASH; `maxHeight` là chất lượng người dùng chọn, 0 là cao nhất. */
  | {
      type: 'engine:add-media';
      url: string;
      filename?: string;
      pageUrl?: string;
      maxHeight?: number;
    }
  /** Đọc danh sách chất lượng của một playlist mà chưa tải gì cả. */
  | { type: 'engine:probe-media'; url: string }
  | { type: 'engine:pause'; id: string }
  | { type: 'engine:resume'; id: string }
  | { type: 'engine:cancel'; id: string }
  /** Chạy lại một việc đã thất bại, giữ nguyên phần đã tải được. */
  | { type: 'engine:retry'; id: string }
  | { type: 'engine:saved'; id: string }
  | { type: 'engine:priority'; id: string; priority: Priority }
  | { type: 'engine:front'; id: string }
  /** Sắp lại toàn bộ hàng đợi theo đúng thứ tự người dùng kéo thả. */
  | { type: 'engine:reorder'; ids: string[] }
  /** Dọn các mục đã xong hoặc đã hỏng khỏi danh sách. */
  | { type: 'engine:clear-finished' }
  /** Cài đặt vừa đổi: engine đọc lại và áp dụng nóng, không cần khởi động lại. */
  | { type: 'engine:settings'; settings: Settings }
  /** Cửa lịch mở hay đóng; do background tính rồi báo xuống. */
  | { type: 'engine:gate'; open: boolean }
  | { type: 'engine:list' }
  /** Dò hàng loạt: trả metadata cho từng URL để người dùng chọn tải cái nào. */
  | { type: 'engine:grab'; urls: string[] }
  | { type: 'engine:ping' };

export type EngineResponse =
  | { ok: true; tasks?: TaskSnapshot[]; id?: string; probe?: MediaProbe; grab?: GrabbedItem[] }
  | { ok: false; error: string };

/**
 * Yêu cầu đi ngược lại, từ engine tới background.
 *
 * Offscreen document của Chromium chỉ chắc chắn dùng được `chrome.runtime`, nên
 * mọi việc đụng tới `downloads`, `notifications`, `storage`, `action` hay
 * `declarativeNetRequest` đều phải nhờ background làm hộ.
 */
export type HostRequest =
  | { type: 'host:save'; taskId: string; blobUrl: string; filename: string }
  | { type: 'host:handback'; url: string; filename?: string }
  | { type: 'host:active'; count: number }
  | { type: 'host:settings' }
  /** Báo cho người dùng biết một việc đã xong hoặc đã hỏng. */
  | { type: 'host:notify'; id: string; title: string; message: string }
  /** Đọc mọi khóa có tiền tố này trong storage.local. */
  | { type: 'host:store-read'; prefix: string }
  | { type: 'host:store-write'; entries: Record<string, unknown> }
  | { type: 'host:store-remove'; keys: string[] }
  /**
   * Cài luật declarativeNetRequest để phát lại các header mà `fetch` cấm đặt
   * (Referer, Origin, Cookie...). Truyền mảng rỗng nghĩa là chỉ gỡ.
   */
  | { type: 'host:rules'; add: HeaderRuleSpec[]; removeIds: number[] };

export type HostResponse =
  | { ok: true; settings?: Settings; entries?: Record<string, unknown> }
  | { ok: false; error: string };

/** Bản rút gọn của DownloadTask để gửi qua message, bỏ mảng piece cho nhẹ. */
export interface TaskSnapshot {
  id: string;
  url: string;
  filename: string;
  size: number | null;
  received: number;
  state: DownloadTask['state'];
  speed: number;
  error: string | null;
  connections: number;
  createdAt: number;
  kind: TaskKind;
  source: TaskSource;
  priority: Priority;
  /** Vị trí trong hàng đợi, 0 là kế tiếp; -1 khi không còn nằm trong hàng. */
  position: number;
  queueState: QueueEntryState | 'none';
  /** Giây còn lại theo tốc độ hiện tại; null khi chưa đoán được. */
  eta: number | null;
}

/** Engine host phát cho mọi UI đang mở. */
export interface EngineBroadcast {
  type: 'engine:update';
  tasks: TaskSnapshot[];
}

/** Một luồng media mà content script nhìn thấy trên trang. */
export interface MediaCandidate {
  url: string;
  kind: 'hls' | 'dash' | 'file';
  via: 'video-src' | 'source-el' | 'resource-timing';
  /** Gợi ý tên file, lấy từ tiêu đề trang. */
  label: string | null;
  duration: number | null;
  width: number | null;
  height: number | null;
}

/** Content script báo về khi thấy luồng media trên trang. */
export interface MediaFound {
  type: 'media:found';
  pageUrl: string;
  pageTitle: string;
  items: MediaCandidate[];
}

/** Popup hỏi background xem tab hiện tại có media nào không. */
export interface MediaListRequest {
  type: 'media:for-tab';
  tabId: number;
}

export interface MediaListResponse {
  pageUrl: string | null;
  pageTitle: string | null;
  items: MediaCandidate[];
}
