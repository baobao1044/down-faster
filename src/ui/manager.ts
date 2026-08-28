import { api } from '../platform/api';
import type { EngineBroadcast, EngineRequest, EngineResponse, TaskSnapshot } from '../shared/rpc';
import type { Priority } from '../engine/queue';
import { loadSettings, saveSettings, type Settings } from '../shared/settings';
import {
  ALL_DAYS,
  formatClock,
  parseClock,
  type ScheduleWindow,
  type Weekday,
} from '../engine/schedule';
import type { RefererMode } from '../engine/adaptive/headers';
import { createEngineChannel } from '../shared/engine-channel';
import { applyI18n, t } from '../shared/i18n';
import { byId, el, on, setClass, setHidden, setText } from './dom';
import { initA11y, installRovingList, ProgressAnnouncer, announce } from './a11y';
import { STATE_LABEL, bytes, eta, speed } from './format';

const listEl = byId('list');
const urlEl = byId<HTMLTextAreaElement>('url');
const addEl = byId<HTMLButtonElement>('add');
const clearEl = byId<HTMLButtonElement>('clear');
const autoEl = byId<HTMLInputElement>('auto');
const autoHintEl = byId('autoHint');
const settingsEl = byId('settings');

const tabDownloads = byId<HTMLButtonElement>('tabDownloads');
const tabSettings = byId<HTMLButtonElement>('tabSettings');
const paneDownloads = byId('paneDownloads');
const paneSettings = byId('paneSettings');

const announcer = new ProgressAnnouncer();
const roving = installRovingList(listEl, { itemSelector: '.task', wrap: true });

let settings: Settings;

/**
 * Cửa chặn engine: đệm lệnh qua cửa sổ race khởi động ~190ms trên Chromium. UI
 * mở sau khi event page đã lên, nhưng listener của offscreen document vẫn có thể
 * đăng ký chậm hơn document, nên ping-gate + đệm FIFO vẫn cần để khỏi mất lệnh.
 */
const channel = createEngineChannel();

function call(request: EngineRequest): Promise<EngineResponse | undefined> {
  return channel.call(request);
}

/* ---------- Tab ---------- */

function showTab(which: 'downloads' | 'settings'): void {
  const downloads = which === 'downloads';
  tabDownloads.setAttribute('aria-selected', String(downloads));
  tabSettings.setAttribute('aria-selected', String(!downloads));
  setHidden(paneDownloads, !downloads);
  setHidden(paneSettings, downloads);
}

on(tabDownloads, 'click', () => showTab('downloads'));
on(tabSettings, 'click', () => showTab('settings'));

/* ---------- Công tắc tự động ---------- */

function reflectAuto(on: boolean): void {
  autoEl.checked = on;
  setText(autoHintEl, t(on ? 'manager_auto_on' : 'manager_auto_off'));
}

on(autoEl, 'change', () => {
  reflectAuto(autoEl.checked);
  void patch({ autoMode: autoEl.checked });
});

/**
 * Lưu rồi giữ lại bản vừa lưu.
 *
 * Background nghe `storage.onChanged` và tự đẩy xuống engine, nên ở đây không
 * cần gửi thêm lệnh nào — gửi nữa là engine áp cùng một thay đổi hai lần.
 */
async function patch(part: Partial<Settings>): Promise<void> {
  settings = await saveSettings(part);
}

/* ---------- Một hàng trong danh sách ---------- */

interface Row {
  root: HTMLElement;
  name: HTMLElement;
  kindBadge: HTMLElement;
  state: HTMLElement;
  bar: HTMLProgressElement;
  meta: HTMLElement;
  error: HTMLElement;
  priority: HTMLSelectElement;
  front: HTMLButtonElement;
  toggle: HTMLButtonElement;
  retry: HTMLButtonElement;
  cancel: HTMLButtonElement;
}

const rows = new Map<string, Row>();

function priorityOption(value: Priority): HTMLOptionElement {
  const option = el('option', { i18n: `priority_${value}` });
  option.value = value;
  return option;
}

function createRow(id: string): Row {
  const name = el('div', { class: 'name' });
  const kindBadge = el('span', { class: 'badge soft', i18n: 'manager_media_badge', hidden: true });
  const state = el('div', { class: 'meta' });
  const head = el('div', { class: 'task-head', children: [name, kindBadge, state] });

  const bar = el('progress', { attrs: { max: 1 } });
  const meta = el('div', { class: 'meta' });
  const error = el('div', { class: 'error', hidden: true });

  const priority = el('select', {
    attrs: { 'aria-label': t('manager_priority_label') },
    children: [priorityOption('high'), priorityOption('normal'), priorityOption('low')],
    on: {
      change: () => {
        void call({ type: 'engine:priority', id, priority: priority.value as Priority });
      },
    },
  });

  const front = el('button', {
    i18n: 'manager_front',
    on: { click: () => void call({ type: 'engine:front', id }) },
  });
  const toggle = el('button', {
    on: {
      click: () => {
        const paused = toggle.dataset['action'] === 'resume';
        void call({ type: paused ? 'engine:resume' : 'engine:pause', id });
      },
    },
  });
  const retry = el('button', {
    i18n: 'manager_retry',
    hidden: true,
    on: { click: () => void call({ type: 'engine:retry', id }) },
  });
  const cancel = el('button', {
    i18n: 'common_cancel',
    on: { click: () => void call({ type: 'engine:cancel', id }) },
  });

  const actions = el('div', {
    class: 'actions',
    children: [priority, front, toggle, retry, cancel],
  });

  const root = el('div', {
    class: 'task',
    role: 'listitem',
    children: [head, bar, meta, error, actions],
  });

  return { root, name, kindBadge, state, bar, meta, error, priority, front, toggle, retry, cancel };
}

function update(row: Row, task: TaskSnapshot): void {
  // textContent chứ không phải innerHTML: tên file do server đặt, không được tin.
  setText(row.name, task.filename);
  setHidden(row.kindBadge, task.kind !== 'media');
  setText(row.state, STATE_LABEL[task.state] ?? task.state);
  row.state.className = `meta state-${task.state}`;

  if (task.size) {
    row.bar.value = Math.min(1, task.received / task.size);
  } else {
    row.bar.removeAttribute('value');
  }

  const parts = [
    task.size ? t('manager_progress_of', { received: bytes(task.received), total: bytes(task.size) }) : bytes(task.received),
  ];
  if (task.state === 'downloading') {
    parts.push(speed(task.speed));
    parts.push(t('manager_eta', { eta: eta(task.received, task.size, task.speed) }));
    parts.push(t('manager_connections', { count: task.connections }));
  } else if (task.queueState === 'waiting' && task.position > 0) {
    parts.push(t('manager_queue_position', { position: task.position + 1 }));
  }
  setText(row.meta, parts.join('  ·  '));

  setText(row.error, task.error ?? '');
  setHidden(row.error, !task.error);

  const running = task.state === 'downloading' || task.state === 'probing';
  const paused = task.state === 'paused';
  const done = task.state === 'completed' || task.state === 'canceled';

  if (row.priority.value !== task.priority) row.priority.value = task.priority;
  setHidden(row.priority, done);
  setHidden(row.front, done || task.position <= 0);
  setHidden(row.toggle, !running && !paused);
  setText(row.toggle, t(paused ? 'common_resume' : 'common_pause'));
  row.toggle.dataset['action'] = paused ? 'resume' : 'pause';
  row.toggle.setAttribute(
    'aria-label',
    t(paused ? 'a11y_resume_task' : 'a11y_pause_task', { name: task.filename }),
  );
  setHidden(row.retry, task.state !== 'failed');
  setHidden(row.cancel, done);
  row.cancel.setAttribute('aria-label', t('a11y_cancel_task', { name: task.filename }));
}

function render(all: TaskSnapshot[]): void {
  // Lượt đã trả lại cho trình duyệt không còn là việc của ta; hiện ra chỉ gây rối.
  const tasks = all.filter((task) => task.state !== 'canceled');
  announcer.update(tasks);
  const seen = new Set<string>();

  for (const task of tasks) {
    seen.add(task.id);
    let row = rows.get(task.id);
    if (!row) {
      row = createRow(task.id);
      rows.set(task.id, row);
      listEl.append(row.root);
    }
    update(row, task);
  }

  for (const [id, row] of rows) {
    if (!seen.has(id)) {
      row.root.remove();
      rows.delete(id);
    }
  }

  let empty = listEl.querySelector('.empty');
  if (!tasks.length && !empty) {
    empty = el('div', { class: 'empty', i18n: 'manager_empty' });
    listEl.append(empty);
  } else if (tasks.length && empty) {
    empty.remove();
  }

  roving.refresh();
}

/* ---------- Thêm việc ---------- */

/**
 * Mỗi dòng một liên kết: dòng đầu là nguồn chính, các dòng sau là nguồn thay thế
 * cho cùng một file. Đây là cách duy nhất người dùng nói được điều đó mà không
 * cần thêm một hộp thoại riêng.
 */
async function submit(): Promise<void> {
  const lines = urlEl.value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^https?:\/\//i.test(line));
  if (lines.length === 0) return;

  const [primary, ...mirrors] = lines;
  if (!primary) return;
  const res = await call({
    type: 'engine:add',
    url: primary,
    source: 'manual',
    ...(mirrors.length ? { mirrors } : {}),
  });
  if (res?.ok) urlEl.value = '';
}

on(addEl, 'click', () => void submit());
on(urlEl, 'keydown', (e) => {
  // Enter gửi, Shift+Enter xuống dòng — vì ô này nhận được nhiều liên kết.
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    void submit();
  }
});
on(clearEl, 'click', () => void call({ type: 'engine:clear-finished' }));

/* ---------- Bảng cài đặt ---------- */

interface FieldSpec {
  titleKey: string;
  hintKey: string;
  control: HTMLElement;
}

function field(spec: FieldSpec): HTMLElement {
  return el('div', {
    class: 'field',
    children: [
      el('div', {
        class: 'label',
        children: [
          el('div', { class: 'title', i18n: spec.titleKey }),
          el('div', { class: 'hint', i18n: spec.hintKey }),
        ],
      }),
      el('div', { class: 'control', children: [spec.control] }),
    ],
  });
}

function numberInput(
  value: number,
  min: number,
  max: number,
  labelKey: string,
  apply: (n: number) => void,
): HTMLInputElement {
  const input = el('input', { attrs: { type: 'number', min, max, 'aria-label': t(labelKey) } });
  input.value = String(value);
  on(input, 'change', () => {
    const parsed = Number(input.value);
    if (!Number.isFinite(parsed)) return;
    const clamped = Math.min(max, Math.max(min, Math.round(parsed)));
    input.value = String(clamped);
    apply(clamped);
    announce(t('a11y_settings_saved'));
  });
  return input;
}

function checkbox(value: boolean, labelKey: string, apply: (on: boolean) => void): HTMLElement {
  const input = el('input', { attrs: { type: 'checkbox', 'aria-label': t(labelKey) } });
  input.checked = value;
  on(input, 'change', () => {
    apply(input.checked);
    announce(t('a11y_settings_saved'));
  });
  return el('label', {
    class: 'switch',
    children: [input, el('span', { class: 'track' }), el('span', { class: 'thumb' })],
  });
}

const REFERER_MODES: RefererMode[] = ['auto', 'full', 'origin', 'off'];

function refererSelect(): HTMLSelectElement {
  const select = el('select', {
    attrs: { 'aria-label': t('settings_referer') },
    children: REFERER_MODES.map((mode) => {
      const option = el('option', { i18n: `referer_${mode}` });
      option.value = mode;
      return option;
    }),
  });
  select.value = settings.replayHeaders;
  on(select, 'change', () => {
    void patch({ replayHeaders: select.value as RefererMode });
    announce(t('a11y_settings_saved'));
  });
  return select;
}

/* ---------- Khung giờ ---------- */

function windowRow(index: number, window: ScheduleWindow): HTMLElement {
  const commit = (next: Partial<ScheduleWindow>): void => {
    const windows = settings.scheduleWindows.map((w, i) =>
      i === index ? { ...w, ...next } : w,
    );
    void patch({ scheduleWindows: windows }).then(renderSettings);
  };

  const from = el('input', { attrs: { type: 'time', 'aria-label': t('schedule_from') } });
  from.value = formatClock(window.start);
  on(from, 'change', () => {
    const minute = parseClock(from.value);
    if (minute !== null) commit({ start: minute });
  });

  const to = el('input', { attrs: { type: 'time', 'aria-label': t('schedule_to') } });
  to.value = formatClock(window.end);
  on(to, 'change', () => {
    const minute = parseClock(to.value);
    if (minute !== null) commit({ end: minute });
  });

  const days = el('div', {
    class: 'days',
    role: 'group',
    attrs: { 'aria-label': t('schedule_days') },
    children: ALL_DAYS.map((day) => {
      const active = window.days.includes(day);
      return el('button', {
        i18n: `weekday_${day}`,
        attrs: { 'aria-pressed': active },
        on: {
          click: () => {
            const next = active
              ? window.days.filter((d) => d !== day)
              : [...window.days, day].sort((a, b) => a - b);
            // Khung không có ngày nào là khung không bao giờ mở; giữ lại ít nhất một.
            if (next.length > 0) commit({ days: next as Weekday[] });
          },
        },
      });
    }),
  });

  return el('div', {
    class: 'window-row',
    children: [
      el('span', { i18n: 'schedule_from' }),
      from,
      el('span', { i18n: 'schedule_to' }),
      to,
      days,
      el('button', {
        class: 'link',
        i18n: 'schedule_remove',
        on: {
          click: () => {
            const windows = settings.scheduleWindows.filter((_, i) => i !== index);
            void patch({ scheduleWindows: windows }).then(renderSettings);
          },
        },
      }),
    ],
  });
}

function scheduleEditor(): HTMLElement {
  const box = el('div');
  if (settings.scheduleWindows.length === 0) {
    box.append(el('p', { class: 'hint', i18n: 'schedule_empty' }));
  }
  settings.scheduleWindows.forEach((window, i) => box.append(windowRow(i, window)));

  box.append(
    el('button', {
      class: 'link',
      i18n: 'schedule_add',
      on: {
        click: () => {
          const windows: ScheduleWindow[] = [
            ...settings.scheduleWindows,
            { start: 22 * 60, end: 6 * 60, days: [...ALL_DAYS] },
          ];
          void patch({ scheduleWindows: windows }).then(renderSettings);
        },
      },
    }),
  );
  return box;
}

function renderSettings(): void {
  settingsEl.textContent = '';
  settingsEl.append(
    el('h2', { class: 'section-title', i18n: 'settings_heading' }),

    field({
      titleKey: 'settings_adaptive',
      hintKey: 'settings_adaptive_hint',
      control: checkbox(settings.adaptiveConnections, 'settings_adaptive', (on) =>
        void patch({ adaptiveConnections: on }),
      ),
    }),
    field({
      titleKey: 'settings_connections',
      hintKey: 'settings_connections_hint',
      control: numberInput(settings.connections, 1, 16, 'settings_connections', (n) =>
        void patch({ connections: n }),
      ),
    }),
    field({
      titleKey: 'settings_concurrent',
      hintKey: 'settings_concurrent_hint',
      control: numberInput(settings.maxConcurrent, 1, 10, 'settings_concurrent', (n) =>
        void patch({ maxConcurrent: n }),
      ),
    }),
    field({
      titleKey: 'settings_speed',
      hintKey: 'settings_speed_hint',
      control: numberInput(
        Math.round(settings.speedLimit / 1024),
        0,
        1_000_000,
        'settings_speed',
        (n) => void patch({ speedLimit: n * 1024 }),
      ),
    }),
    field({
      titleKey: 'settings_min_size',
      hintKey: 'settings_min_size_hint',
      control: numberInput(
        Math.round(settings.minInterceptSize / (1024 * 1024)),
        0,
        10_000,
        'settings_min_size',
        (n) => void patch({ minInterceptSize: n * 1024 * 1024 }),
      ),
    }),
    field({
      titleKey: 'settings_streaming',
      hintKey: 'settings_streaming_hint',
      control: checkbox(settings.allowStreaming, 'settings_streaming', (on) =>
        void patch({ allowStreaming: on }),
      ),
    }),
    field({
      titleKey: 'settings_detect_media',
      hintKey: 'settings_detect_media_hint',
      control: checkbox(settings.detectMedia, 'settings_detect_media', (on) =>
        void patch({ detectMedia: on }),
      ),
    }),
    field({
      titleKey: 'settings_referer',
      hintKey: 'settings_referer_hint',
      control: refererSelect(),
    }),
    field({
      titleKey: 'settings_schedule',
      hintKey: 'settings_schedule_hint',
      control: checkbox(settings.scheduleEnabled, 'settings_schedule', (on) => {
        void patch({ scheduleEnabled: on }).then(renderSettings);
      }),
    }),
  );

  if (settings.scheduleEnabled) settingsEl.append(scheduleEditor());
}

/* ---------- Khởi động ---------- */

api.runtime.onMessage.addListener((message: unknown) => {
  const msg = message as EngineBroadcast;
  if (msg?.type === 'engine:update') render(msg.tasks);
  return false;
});

void (async () => {
  initA11y();
  applyI18n();
  settings = await loadSettings();
  reflectAuto(settings.autoMode);
  renderSettings();
  setClass(document.body, 'ready', true);

  const res = await call({ type: 'engine:list' });
  render(res?.ok ? (res.tasks ?? []) : []);
})();
