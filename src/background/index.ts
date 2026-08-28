import { api, ensureDocumentContext, isFirefox } from '../platform/api';
import { dispatchEngineRequest, installEngineHost, type DownloadManager } from '../engine/manager';
import type { HostBridge } from '../engine/host';
import { shouldIntercept } from '../engine/policy';
import { storeFromArea, type PersistenceStore } from '../engine/persistence';
import { allRuleIds, type HeaderRuleSpec } from '../engine/adaptive/headers';
import { ScheduleController, type AlarmPort } from '../engine/schedule';
import { loadSettings, saveSettings, type Settings } from '../shared/settings';
import type {
  EngineRequest,
  HostRequest,
  HostResponse,
  MediaCandidate,
  MediaFound,
  MediaListResponse,
} from '../shared/rpc';
import { createEngineChannel } from '../shared/engine-channel';
import { log, warn } from '../shared/log';

/**
 * Background.
 *
 * Đây là nơi duy nhất có đủ quyền gọi các API của trình duyệt, nên mọi việc đụng
 * tới `downloads`, `storage`, `notifications`, `alarms`, `action` hay
 * `declarativeNetRequest` đều dồn về đây. Trên Firefox background cũng kiêm luôn
 * engine host vì event page vốn có DOM; trên Chromium service worker không có
 * DOM nên engine sống ở offscreen document.
 */

const MENU_LINK = 'df-download-link';
const MENU_MEDIA = 'df-download-media';
const MENU_MANAGER = 'df-open-manager';
const ICON = 'icons/128.png';

/** Chỉ có giá trị trên Firefox, nơi engine chạy chung ngữ cảnh với background. */
let localManager: DownloadManager | null = null;
/**
 * Engine của Firefox dựng bất đồng bộ vì phải đọc cài đặt trước. Lệnh đầu tiên
 * thường tới trong cùng nhịp đó — menu chuột phải, hoặc một lượt tải vừa giành
 * được — nên phải chờ được, không thì nó rơi mất một cách im lặng.
 */
let localReady: Promise<DownloadManager> | null = null;

/** taskId của engine, tra theo id lượt tải của trình duyệt. */
const savingTasks = new Map<number, string>();

/**
 * URL vừa được trả lại cho trình duyệt. Nếu không nhớ, `onCreated` sẽ giành lại
 * đúng lượt tải mà engine vừa buông ra và tạo thành vòng lặp vô tận.
 */
const handedBack = new Set<string>();

/** Media mà content script thấy được, theo từng tab. */
const mediaByTab = new Map<
  number,
  { pageUrl: string; pageTitle: string; items: MediaCandidate[] }
>();

/* ---------- Cầu nối cho engine ---------- */

async function saveFile(req: { taskId: string; blobUrl: string; filename: string }): Promise<void> {
  const id = await api.downloads.download({
    url: req.blobUrl,
    filename: req.filename,
    saveAs: false,
  });
  savingTasks.set(id, req.taskId);
}

async function handBack(req: { url: string; filename?: string }): Promise<void> {
  handedBack.add(req.url);
  try {
    await api.downloads.download({ url: req.url, ...(req.filename && { filename: req.filename }) });
    log('background', `đã trả lại cho trình duyệt: ${req.url}`);
  } finally {
    // Giữ đủ lâu để lượt tải kịp bắt đầu, rồi quên đi cho khỏi rò rỉ.
    setTimeout(() => handedBack.delete(req.url), 60_000);
  }
}

function setBadge(count: number): void {
  const action = api.action ?? (api as unknown as { browserAction?: typeof api.action }).browserAction;
  if (!action) return;
  void action.setBadgeText({ text: count > 0 ? String(count) : '' });
  void action.setBadgeBackgroundColor?.({ color: '#2563eb' });
}

function notify(req: { id: string; title: string; message: string }): void {
  try {
    void api.notifications?.create(`df-${req.id}`, {
      type: 'basic',
      iconUrl: api.runtime.getURL(ICON),
      title: req.title,
      message: req.message,
    });
  } catch {
    // Người dùng có thể đã tắt thông báo; không phải lỗi đáng dừng việc.
  }
}

const store: PersistenceStore = storeFromArea({
  get: (keys) => api.storage.local.get(keys) as Promise<Record<string, unknown>>,
  set: (items) => api.storage.local.set(items),
  remove: (keys) => api.storage.local.remove(keys),
});

/* ---------- Luật phát lại header ---------- */

type DnrApi = {
  updateSessionRules(options: {
    addRules?: unknown[];
    removeRuleIds?: number[];
  }): Promise<void>;
};

function dnr(): DnrApi | null {
  return (api as unknown as { declarativeNetRequest?: DnrApi }).declarativeNetRequest ?? null;
}

/** HeaderRuleSpec cố tình không biết gì về hình dạng rule của chrome; đổi ở đây. */
function toDnrRule(spec: HeaderRuleSpec): unknown {
  return {
    id: spec.id,
    priority: 1,
    action: { type: 'modifyHeaders', requestHeaders: spec.requestHeaders },
    condition: {
      ...(spec.urlFilter ? { urlFilter: spec.urlFilter } : {}),
      ...(spec.requestDomains ? { requestDomains: spec.requestDomains } : {}),
      ...(spec.tabIds ? { tabIds: spec.tabIds } : {}),
    },
  };
}

async function applyHeaderRules(req: {
  add: HeaderRuleSpec[];
  removeIds: number[];
}): Promise<boolean> {
  const engine = dnr();
  if (!engine) return false;
  try {
    await engine.updateSessionRules({
      removeRuleIds: req.removeIds,
      addRules: req.add.map(toDnrRule),
    });
    return true;
  } catch (err) {
    warn('background', 'không cài được luật header', err);
    return false;
  }
}

/** Báo engine biết trình duyệt đã lưu xong để nó dọn file tạm. */
function notifySaved(taskId: string): void {
  if (localManager) localManager.saved(taskId);
  else void api.runtime.sendMessage({ type: 'engine:saved', id: taskId } satisfies EngineRequest).catch(() => {});
}

const bridge: HostBridge = {
  saveFile,
  handBack,
  setActiveCount: setBadge,
  loadSettings,
  store,
  notify,
  applyHeaderRules,
};

/* ---------- Khung giờ tải ---------- */

const alarmPort: AlarmPort = {
  create: (name, when) => api.alarms?.create(name, { when }),
  createPeriodic: (name, minutes) => api.alarms?.create(name, { periodInMinutes: minutes }),
  clear: (name) => void api.alarms?.clear(name),
};

const schedule = new ScheduleController({
  alarms: alarmPort,
  onGate: (open) => {
    void send({ type: 'engine:gate', open });
    log('background', open ? 'tới khung giờ tải' : 'ngoài khung giờ tải, tạm dừng');
  },
});

api.alarms?.onAlarm.addListener((alarm) => {
  if (schedule.handlesAlarm(alarm.name)) schedule.sync();
});

/** Đẩy cài đặt mới xuống engine và tính lại khung giờ. */
async function pushSettings(settings: Settings): Promise<void> {
  schedule.configure(settings.scheduleEnabled, settings.scheduleWindows);
  await send({ type: 'engine:settings', settings });
}

if (isFirefox) {
  localReady = (async () => {
    const settings = await loadSettings();
    localManager = installEngineHost(bridge, settings);
    schedule.configure(settings.scheduleEnabled, settings.scheduleWindows);
    return localManager;
  })();
}

/**
 * Cửa chặn engine: đệm mọi lệnh qua cửa sổ race khởi động ~190ms trên Chromium
 * (engine ở offscreen document, listener đăng ký chậm hơn document), và gửi
 * thẳng trên Firefox. Tạo một lần ở tầm module.
 */
const channel = createEngineChannel({
  // Firefox: engine chạy cùng ngữ cảnh với background, mà runtime.sendMessage
  // không gửi được cho chính người gửi — gọi thẳng dispatchEngineRequest. Giữ
  // nguyên nhánh localReady cũ: chờ engine dựng xong rồi mới phát lệnh.
  directDispatch: isFirefox
    ? async (request) => {
        if (!localReady) return undefined;
        dispatchEngineRequest(await localReady, request, () => {});
        return undefined;
      }
    : undefined,
});

/** Phát lệnh tới engine; không bao giờ mất lệnh trong cửa sổ race khởi động. */
function send(request: EngineRequest): Promise<void> {
  return channel.send(request);
}

/* ---------- Nhận yêu cầu từ engine (chỉ Chromium dùng đường này) ---------- */

api.runtime.onMessage.addListener(
  (message: unknown, _sender, sendResponse: (r: HostResponse) => void) => {
    const req = message as HostRequest;
    if (typeof req?.type !== 'string' || !req.type.startsWith('host:')) return false;

    switch (req.type) {
      case 'host:save':
        void saveFile(req)
          .then(() => sendResponse({ ok: true }))
          .catch((err) => sendResponse({ ok: false, error: String(err) }));
        return true;
      case 'host:handback':
        void handBack(req)
          .then(() => sendResponse({ ok: true }))
          .catch((err) => sendResponse({ ok: false, error: String(err) }));
        return true;
      case 'host:active':
        setBadge(req.count);
        sendResponse({ ok: true });
        return false;
      case 'host:settings':
        void loadSettings().then((settings) => sendResponse({ ok: true, settings }));
        return true;
      case 'host:notify':
        notify(req);
        sendResponse({ ok: true });
        return false;
      case 'host:store-read':
        void store
          .read(req.prefix)
          .then((entries) => sendResponse({ ok: true, entries }))
          .catch((err) => sendResponse({ ok: false, error: String(err) }));
        return true;
      case 'host:store-write':
        void store
          .write(req.entries)
          .then(() => sendResponse({ ok: true }))
          .catch((err) => sendResponse({ ok: false, error: String(err) }));
        return true;
      case 'host:store-remove':
        void store
          .remove(req.keys)
          .then(() => sendResponse({ ok: true }))
          .catch((err) => sendResponse({ ok: false, error: String(err) }));
        return true;
      case 'host:rules':
        void applyHeaderRules(req).then((ok) =>
          sendResponse(ok ? { ok: true } : { ok: false, error: 'trình duyệt từ chối luật' }),
        );
        return true;
      default:
        return false;
    }
  },
);

/* ---------- Media mà content script tìm thấy ---------- */

api.runtime.onMessage.addListener(
  (message: unknown, sender, sendResponse: (r: MediaListResponse) => void) => {
    const msg = message as { type?: string } | null;

    if (msg?.type === 'media:found') {
      const found = message as MediaFound;
      const tabId = sender.tab?.id;
      if (tabId === undefined) return false;
      const bucket = mediaByTab.get(tabId);
      // Cùng một trang phát lại nhiều lần sẽ báo trùng URL; gộp theo URL để danh
      // sách trong popup không phình ra thành hàng chục dòng giống hệt nhau.
      const merged = new Map<string, MediaCandidate>();
      if (bucket && bucket.pageUrl === found.pageUrl) {
        for (const item of bucket.items) merged.set(item.url, item);
      }
      for (const item of found.items) merged.set(item.url, item);
      mediaByTab.set(tabId, {
        pageUrl: found.pageUrl,
        pageTitle: found.pageTitle,
        items: [...merged.values()].slice(-24),
      });
      return false;
    }

    if (msg?.type === 'media:for-tab') {
      const { tabId } = message as { tabId: number };
      const bucket = mediaByTab.get(tabId);
      sendResponse({
        pageUrl: bucket?.pageUrl ?? null,
        pageTitle: bucket?.pageTitle ?? null,
        items: bucket?.items ?? [],
      });
      return false;
    }

    return false;
  },
);

api.tabs?.onRemoved.addListener((tabId) => mediaByTab.delete(tabId));

/* ---------- Vòng đời lượt tải của trình duyệt ---------- */

api.downloads?.onChanged.addListener((delta) => {
  const taskId = savingTasks.get(delta.id);
  if (!taskId) return;
  const state = delta.state?.current;
  if (state !== 'complete' && state !== 'interrupted') return;
  savingTasks.delete(delta.id);
  notifySaved(taskId);
});

api.downloads?.onCreated.addListener((item) => {
  void (async () => {
    const settings = await loadSettings();
    if (!settings.autoMode) return;
    const fit = shouldIntercept(item, {
      minSize: settings.minInterceptSize,
      selfId: api.runtime.id,
      handedBack,
    });
    if (!fit) return;

    try {
      await api.downloads.cancel(item.id);
      await api.downloads.erase({ id: item.id });
    } catch (err) {
      // Không hủy được thì cứ để trình duyệt tải tiếp, đừng làm hỏng việc của nó.
      warn('background', 'không giành được lượt tải, bỏ qua', err);
      return;
    }

    await send({
      type: 'engine:add',
      url: item.finalUrl || item.url,
      source: 'auto',
      // Nguồn dẫn là thứ duy nhất cứu được những link chỉ sống khi có đúng Referer,
      // và `DownloadItem.referrer` cho không, không cần thêm quyền nào.
      ...(item.referrer && { pageUrl: item.referrer }),
      ...(item.filename && { filename: item.filename.replace(/^.*[\\/]/, '') }),
    });

    void showFirstRunNotice();
  })();
});

/**
 * Trong lúc engine tải, thanh download quen thuộc của trình duyệt không hiện gì.
 * Với file lớn đó là vài phút im lặng, đủ để người dùng tưởng máy hỏng. Nói một
 * lần duy nhất cho họ biết chuyện gì đang xảy ra.
 */
async function showFirstRunNotice(): Promise<void> {
  const settings = await loadSettings();
  if (settings.firstRunNoticeShown) return;
  await saveSettings({ firstRunNoticeShown: true });

  notify({
    id: 'first-run',
    title: 'Đang tăng tốc lượt tải này',
    message:
      'Down Faster tải file bằng nhiều kết nối cùng lúc. Bấm biểu tượng trên thanh công cụ để xem tiến độ.',
  });
}

/* ---------- Menu và biểu tượng ---------- */

function installMenus(): void {
  api.contextMenus?.removeAll(() => {
    api.contextMenus.create({
      id: MENU_LINK,
      title: 'Tải bằng Down Faster',
      contexts: ['link', 'image'],
    });
    api.contextMenus.create({
      id: MENU_MEDIA,
      title: 'Tải video/nhạc này',
      contexts: ['video', 'audio'],
    });
    api.contextMenus.create({
      id: MENU_MANAGER,
      title: 'Mở danh sách tải',
      contexts: ['action'],
    });
  });
}

api.contextMenus?.onClicked.addListener((info) => {
  if (info.menuItemId === MENU_MANAGER) {
    void api.tabs.create({ url: api.runtime.getURL('manager.html') });
    return;
  }

  const url = info.linkUrl ?? info.srcUrl;
  if (!url) return;

  if (info.menuItemId === MENU_MEDIA) {
    void send({ type: 'engine:add-media', url, ...(info.pageUrl && { pageUrl: info.pageUrl }) });
    return;
  }
  if (info.menuItemId === MENU_LINK) {
    void send({
      type: 'engine:add',
      url,
      source: 'manual',
      ...(info.pageUrl && { pageUrl: info.pageUrl }),
    });
  }
});

/** Cài đặt đổi ở trang tùy chọn: áp nóng, không bắt người dùng khởi động lại gì. */
api.storage?.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.settings) return;
  void loadSettings().then(pushSettings);
});

api.runtime.onInstalled.addListener((details) => {
  installMenus();
  void bootstrap();
  if (details.reason === 'install') {
    void api.tabs.create({ url: api.runtime.getURL('welcome.html') });
  }
  log('background', 'đã cài đặt');
});

api.runtime.onStartup?.addListener(() => {
  installMenus();
  setBadge(0);
  void bootstrap();
});

/**
 * Rule của phiên trước có thể còn sót nếu trình duyệt tắt đột ngột. Một luật cũ
 * gắn Referer sai vào request mới là loại lỗi cực khó lần ra, nên dọn sạch dải
 * id của mình trước khi làm bất cứ việc gì khác.
 */
async function bootstrap(): Promise<void> {
  await applyHeaderRules({ add: [], removeIds: allRuleIds() });
  const settings = await loadSettings();
  await pushSettings(settings);
}

// Chromium: dựng sẵn offscreen ngay khi khởi động để lượt tải đầu không phải chờ.
if (!isFirefox) {
  void ensureDocumentContext()
    .then(() => bootstrap())
    .catch((err) => warn('background', 'offscreen lỗi', err));
}
