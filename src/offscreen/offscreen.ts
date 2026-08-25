import { installEngineHost } from '../engine/manager';
import type { HostBridge } from '../engine/host';
import type { PersistenceStore } from '../engine/persistence';
import { api } from '../platform/api';
import { DEFAULT_SETTINGS, type Settings } from '../shared/settings';
import type { HostRequest, HostResponse } from '../shared/rpc';

/**
 * Trang này không hiện ra và cũng không cần hiện. Nó tồn tại chỉ để cho engine
 * một ngữ cảnh có DOM trên Chromium: nơi spawn được Worker và tạo được blob URL,
 * hai thứ service worker của MV3 không làm được.
 *
 * Đổi lại, offscreen document gần như không dùng được extension API nào ngoài
 * `chrome.runtime`, nên mọi việc khác — kể cả `storage` — đều nhờ background.
 */

async function ask(request: HostRequest): Promise<HostResponse | undefined> {
  try {
    return (await api.runtime.sendMessage(request)) as HostResponse;
  } catch {
    return undefined;
  }
}

/**
 * Ném lỗi khi background không trả lời được.
 *
 * TaskPersistence bắt lỗi và thử lại; nuốt lỗi ở đây rồi trả về "xong" sẽ khiến
 * nó tưởng đã chốt sổ và bỏ luôn phần tiến độ đó.
 */
async function demand(request: HostRequest): Promise<HostResponse> {
  const res = await ask(request);
  if (!res) throw new Error('Background không phản hồi');
  if (!res.ok) throw new Error(res.error);
  return res;
}

const store: PersistenceStore = {
  async read(prefix) {
    const res = await demand({ type: 'host:store-read', prefix });
    return res.ok ? res.entries ?? {} : {};
  },
  async write(entries) {
    if (Object.keys(entries).length === 0) return;
    await demand({ type: 'host:store-write', entries });
  },
  async remove(keys) {
    if (keys.length === 0) return;
    await demand({ type: 'host:store-remove', keys });
  },
};

const bridge: HostBridge = {
  async saveFile(request) {
    await ask({ type: 'host:save', ...request });
  },
  async handBack(request) {
    await ask({ type: 'host:handback', ...request });
  },
  setActiveCount(count) {
    void ask({ type: 'host:active', count });
  },
  async loadSettings(): Promise<Settings> {
    const res = await ask({ type: 'host:settings' });
    return res?.ok && res.settings ? res.settings : { ...DEFAULT_SETTINGS };
  },
  store,
  notify(request) {
    void ask({ type: 'host:notify', ...request });
  },
  async applyHeaderRules(request) {
    const res = await ask({ type: 'host:rules', ...request });
    return res?.ok === true;
  },
};

void (async () => {
  const settings = await bridge.loadSettings();
  installEngineHost(bridge, settings);
})();
