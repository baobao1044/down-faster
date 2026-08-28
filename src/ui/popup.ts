import { api } from '../platform/api';
import type {
  EngineBroadcast,
  EngineRequest,
  EngineResponse,
  MediaCandidate,
  MediaListResponse,
  TaskSnapshot,
} from '../shared/rpc';
import { createEngineChannel } from '../shared/engine-channel';
import { loadSettings, saveSettings } from '../shared/settings';
import { applyI18n, t } from '../shared/i18n';
import { byId, el, on, setHidden, setText } from './dom';
import { announce, initA11y, ProgressAnnouncer } from './a11y';
import { bytes, eta, speed } from './format';

const autoEl = byId<HTMLInputElement>('auto');
const autoHintEl = byId('autoHint');
const listEl = byId('list');
const mediaBoxEl = byId('mediaBox');
const mediaEl = byId('media');
const urlEl = byId<HTMLInputElement>('url');
const addEl = byId<HTMLButtonElement>('add');
const openEl = byId<HTMLButtonElement>('open');

const announcer = new ProgressAnnouncer();

/**
 * Cửa chặn engine: đệm lệnh qua cửa sổ race khởi động ~190ms trên Chromium. UI
 * mở sau khi event page đã lên, nhưng listener của offscreen document vẫn có thể
 * đăng ký chậm hơn document, nên ping-gate + đệm FIFO vẫn cần để khỏi mất lệnh.
 */
const channel = createEngineChannel();

function call(request: EngineRequest): Promise<EngineResponse | undefined> {
  return channel.call(request);
}

/* ---------- Công tắc ---------- */

function reflectAuto(on: boolean): void {
  autoEl.checked = on;
  setText(autoHintEl, t(on ? 'popup_auto_on' : 'popup_auto_off'));
}

on(autoEl, 'change', () => {
  reflectAuto(autoEl.checked);
  void saveSettings({ autoMode: autoEl.checked });
});

/* ---------- Video tìm thấy trên trang ---------- */

/**
 * Người dùng phổ thông không biết .m3u8 là gì, và cũng không nên phải biết. Họ
 * chỉ thấy "trang này có video" và một nút bấm.
 */
function renderMedia(list: MediaCandidate[], pageUrl: string | null, title: string | null): void {
  mediaEl.textContent = '';
  const usable = list.filter((item) => item.kind !== 'file' || /^https?:/i.test(item.url));
  setHidden(mediaBoxEl, usable.length === 0);
  if (usable.length === 0) return;

  for (const item of usable.slice(0, 3)) {
    const label =
      item.label ??
      title ??
      // Tên miền là thứ duy nhất chắc chắn có ý nghĩa với người đọc khi mọi gợi ý khác trống.
      (() => {
        try {
          return new URL(item.url).hostname;
        } catch {
          return item.url;
        }
      })();

    const size =
      item.width && item.height ? t('popup_media_quality', { width: item.width, height: item.height }) : '';

    mediaEl.append(
      el('div', {
        class: 'task',
        children: [
          el('div', { class: 'task-head', children: [el('div', { class: 'name', text: label })] }),
          el('div', { class: 'meta', text: size }),
          el('button', {
            i18n: 'popup_media_download',
            on: {
              click: () => {
                void call({
                  type: 'engine:add-media',
                  url: item.url,
                  ...(item.label ? { filename: item.label } : {}),
                  ...(pageUrl ? { pageUrl } : {}),
                });
                announce(t('popup_media_download'));
              },
            },
          }),
        ],
      }),
    );
  }
}

async function loadMedia(): Promise<void> {
  if (!(await loadSettings()).detectMedia) return;
  try {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined) return;
    const res = (await api.runtime.sendMessage({
      type: 'media:for-tab',
      tabId: tab.id,
    })) as MediaListResponse | undefined;
    if (res) renderMedia(res.items, res.pageUrl, res.pageTitle);
  } catch {
    // Tab nội bộ của trình duyệt không chạy content script; im lặng là đúng.
  }
}

/* ---------- Danh sách ---------- */

/**
 * Người dùng phổ thông chỉ cần biết ba điều: đang tải cái gì, còn bao lâu, và
 * nó có đang chạy không. Số kết nối hay số piece để dành cho trang quản lý.
 */
function statusOf(task: TaskSnapshot): string {
  switch (task.state) {
    case 'downloading':
      return t('popup_status_downloading', {
        speed: speed(task.speed),
        eta: eta(task.received, task.size, task.speed),
      });
    case 'paused':
      return task.queueState === 'waiting'
        ? t('manager_paused_by_schedule')
        : t('popup_status_paused');
    case 'probing':
    case 'queued':
      return task.position > 0
        ? t('manager_queue_position', { position: task.position + 1 })
        : t('popup_status_preparing');
    case 'assembling':
      return t('popup_status_assembling');
    case 'failed':
      return t('popup_status_failed');
    default:
      return task.size ? bytes(task.size) : '';
  }
}

function renderTask(task: TaskSnapshot): HTMLElement {
  const head = el('div', {
    class: 'task-head',
    // Tên file do server đặt: `text` đi qua textContent nên không có đường thành HTML.
    children: [el('div', { class: 'name', text: task.filename })],
  });

  if (task.connections > 1) {
    head.append(
      el('span', {
        class: 'badge',
        i18n: 'popup_threads_badge',
        i18nParams: { count: task.connections },
        attrs: { title: t('popup_threads_title', { count: task.connections }) },
      }),
    );
  }

  const bar = el('progress', { attrs: { max: 1 } });
  if (task.size) bar.value = Math.min(1, task.received / task.size);

  return el('div', {
    class: 'task',
    children: [
      head,
      bar,
      el('div', { class: `meta${task.state === 'failed' ? ' state-failed' : ''}`, text: statusOf(task) }),
    ],
  });
}

function render(tasks: TaskSnapshot[]): void {
  const visible = tasks.filter((task) => task.state !== 'canceled');
  announcer.update(visible);
  listEl.textContent = '';

  if (!visible.length) {
    listEl.append(el('div', { class: 'empty', i18n: 'popup_empty' }));
    return;
  }
  for (const task of visible.slice(0, 4)) listEl.append(renderTask(task));
}

/* ---------- Thao tác ---------- */

async function submit(): Promise<void> {
  const url = urlEl.value.trim();
  if (!url) return;
  const res = await call({ type: 'engine:add', url, source: 'manual' });
  if (res?.ok) urlEl.value = '';
}

on(addEl, 'click', () => void submit());
on(urlEl, 'keydown', (e) => {
  if (e.key === 'Enter') void submit();
});

on(openEl, 'click', () => {
  void api.tabs.create({ url: api.runtime.getURL('manager.html') });
  window.close();
});

api.runtime.onMessage.addListener((message: unknown) => {
  const msg = message as EngineBroadcast;
  if (msg?.type === 'engine:update') render(msg.tasks);
  return false;
});

void (async () => {
  initA11y();
  applyI18n();
  reflectAuto((await loadSettings()).autoMode);
  const res = await call({ type: 'engine:list' });
  render(res?.ok ? (res.tasks ?? []) : []);
  await loadMedia();
})();
