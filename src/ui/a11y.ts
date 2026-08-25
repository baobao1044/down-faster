/**
 * Tiện ích trợ năng cho các trang UI.
 *
 * Vấn đề trung tâm của module này: UI phát snapshot mỗi 400ms. Nếu cứ mỗi
 * snapshot lại đẩy một câu vào vùng aria-live thì trình đọc màn hình sẽ đọc số
 * không ngừng và extension trở thành không dùng được. Nhưng bỏ bớt thay đổi
 * trạng thái thì người dùng mất đúng cái tin quan trọng nhất (xong / thất bại).
 * Nên: trạng thái không bao giờ bị bỏ, chỉ tiến độ mới bị tiết chế theo mốc.
 *
 * Phần lõi chọn mốc (`milestoneFor`) là hàm thuần, tách hẳn khỏi DOM, vì Node
 * không có DOM và dự án cấm thêm dependency — đó là cách duy nhất để phần logic
 * dễ sai nhất (ngưỡng, giãn cách, ưu tiên) có test thật.
 */

import { t } from '../shared/i18n';
import { on, queryAll } from './dom';

export type Politeness = 'polite' | 'assertive';

/* ---------- Vùng aria-live ---------- */

const POLITE_ID = 'df-live-polite';
const ASSERTIVE_ID = 'df-live-assertive';

/** Đọc lại đúng câu vừa đọc cần một nhịp trống ở giữa; xem `announce`. */
const REPEAT_DELAY_MS = 60;

/**
 * Hẹn giờ đọc lại, tách RIÊNG cho từng vùng.
 *
 * Dùng chung một biến cho cả hai vùng là sai: nhịp chờ của vùng thường bắt đầu
 * bằng việc xóa trắng vùng đó, nên một câu khẩn xen vào giữa 60ms ấy sẽ hủy hẹn
 * giờ và bỏ vùng thường trống vĩnh viễn — câu đang chờ không bao giờ được đọc.
 */
const repeatTimers = new Map<string, ReturnType<typeof setTimeout>>();

function cancelRepeat(id: string): void {
  const timer = repeatTimers.get(id);
  if (timer === undefined) return;
  clearTimeout(timer);
  repeatTimers.delete(id);
}

/** Ẩn khỏi mắt nhưng vẫn nằm trong cây trợ năng. `display:none` thì trình đọc cũng không thấy. */
function hideVisually(node: HTMLElement): void {
  const s = node.style;
  s.position = 'absolute';
  s.width = '1px';
  s.height = '1px';
  s.margin = '-1px';
  s.padding = '0';
  s.overflow = 'hidden';
  s.clipPath = 'inset(50%)';
  s.whiteSpace = 'nowrap';
  s.border = '0';
}

function ensureRegion(id: string, politeness: Politeness): HTMLElement | null {
  if (typeof document === 'undefined' || !document.body) return null;
  const existing = document.getElementById(id);
  if (existing) return existing;

  const region = document.createElement('div');
  region.id = id;
  region.className = 'sr-only';
  // role và aria-live nói cùng một điều, nhưng vài trình đọc chỉ nghe một trong
  // hai, nên đặt cả hai là cách rẻ nhất để không phải đoán.
  region.setAttribute('role', politeness === 'assertive' ? 'alert' : 'status');
  region.setAttribute('aria-live', politeness);
  // Đọc trọn câu mới chứ không chỉ phần khác đi so với câu cũ.
  region.setAttribute('aria-atomic', 'true');
  hideVisually(region);
  document.body.appendChild(region);
  return region;
}

/**
 * Dựng sẵn hai vùng live RỖNG và ghi `data-motion` lên `<html>`.
 *
 * Phải gọi lúc trang khởi động, không được dựng lười tới lúc thông báo đầu tiên:
 * trình đọc màn hình chỉ theo dõi vùng live đã có mặt từ trước, nên nếu chèn cả
 * vùng lẫn nội dung trong cùng một nhịp thì câu đầu tiên bị nuốt mất.
 */
export function initA11y(): void {
  ensureRegion(POLITE_ID, 'polite');
  ensureRegion(ASSERTIVE_ID, 'assertive');
  reflectMotionPreference();
}

/**
 * Đẩy một câu vào vùng live.
 *
 * Nếu câu giống hệt câu đang nằm đó thì phải xóa rỗng rồi đặt lại sau một nhịp:
 * vài trình đọc so sánh nội dung và bỏ qua khi không đổi, nên "Đã tải xong A"
 * hai lần liên tiếp sẽ chỉ được đọc một lần.
 */
export function announce(message: string, politeness: Politeness = 'polite'): void {
  const id = politeness === 'assertive' ? ASSERTIVE_ID : POLITE_ID;
  const region = ensureRegion(id, politeness);
  if (!region) return;

  const trimmed = message.trim();
  if (!trimmed) return;

  // Chỉ hủy nhịp chờ của CHÍNH vùng này; vùng kia đang chờ thì mặc kệ nó chờ.
  cancelRepeat(id);

  if (region.textContent === trimmed) {
    region.textContent = '';
    repeatTimers.set(
      id,
      setTimeout(() => {
        repeatTimers.delete(id);
        region.textContent = trimmed;
      }, REPEAT_DELAY_MS),
    );
    return;
  }

  region.textContent = trimmed;
}

export function clearAnnouncements(): void {
  for (const id of [POLITE_ID, ASSERTIVE_ID]) {
    cancelRepeat(id);
    if (typeof document === 'undefined') continue;
    const region = document.getElementById(id);
    if (region) region.textContent = '';
  }
}

/* ---------- Lõi chọn mốc (thuần, có test) ---------- */

/**
 * Hình dạng tối thiểu của một lượt tải mà bộ thông báo cần biết. Cố tình không
 * import `TaskSnapshot` để phần lõi không kéo theo cả nhánh rpc/engine khi test.
 */
export interface AnnounceableTask {
  id: string;
  filename: string;
  state: string;
  received: number;
  size: number | null;
  error?: string | null;
}

export interface MilestoneOptions {
  /** Bước phần trăm giữa hai lần đọc tiến độ. */
  stepPercent?: number;
  /** Giãn cách tối thiểu giữa hai lần đọc tiến độ của cùng một lượt, ms. */
  minGapMs?: number;
}

export const MILESTONE_DEFAULTS: Required<MilestoneOptions> = {
  stepPercent: 25,
  minGapMs: 15_000,
};

export interface TaskMemory {
  state: string;
  /** Mốc phần trăm gần nhất ĐÃ đọc, không phải phần trăm hiện tại. */
  percentAnnounced: number;
  at: number;
}

export interface Milestone {
  text: string;
  politeness: Politeness;
  kind: 'state' | 'progress';
}

function percentOf(task: AnnounceableTask): number {
  if (!task.size || task.size <= 0) return 0;
  return Math.max(0, Math.min(100, Math.floor((task.received / task.size) * 100)));
}

function bucketOf(percent: number, step: number): number {
  if (step <= 0) return percent;
  return Math.floor(percent / step) * step;
}

function stateMilestone(task: AnnounceableTask, previousState: string | undefined): Milestone {
  const name = task.filename;
  switch (task.state) {
    case 'downloading':
      // Từ 'paused' sang là chạy tiếp, còn lại là bắt đầu — hai việc khác nhau
      // với người chỉ nghe chứ không nhìn.
      return {
        text: t(previousState === 'paused' ? 'a11y_resumed' : 'a11y_started', { name }),
        politeness: 'polite',
        kind: 'state',
      };
    case 'paused':
      return { text: t('a11y_paused', { name }), politeness: 'polite', kind: 'state' };
    case 'assembling':
      return { text: t('a11y_assembling', { name }), politeness: 'polite', kind: 'state' };
    case 'completed':
      return { text: t('a11y_completed', { name }), politeness: 'polite', kind: 'state' };
    case 'canceled':
      return { text: t('a11y_canceled', { name }), politeness: 'polite', kind: 'state' };
    case 'failed':
      return {
        text: t('a11y_failed', { name, reason: task.error ?? t('error_generic') }),
        // Thất bại là tin duy nhất đáng cắt ngang câu đang đọc dở.
        politeness: 'assertive',
        kind: 'state',
      };
    default:
      // queued, probing, và bất cứ trạng thái nào engine thêm về sau. Ghép tên
      // với nhãn trạng thái còn hơn im lặng nuốt mất một thay đổi.
      return {
        text: t('a11y_state_change', {
          name,
          state: t(`state_${task.state}`, undefined, task.state),
        }),
        politeness: 'polite',
        kind: 'state',
      };
  }
}

/**
 * Có gì đáng đọc cho lượt tải này không.
 *
 * `memory` trả về là trạng thái SẼ ghi nếu mốc này thật sự được đọc. Người gọi
 * không đọc thì không được ghi — nhờ vậy một mốc bị nhường lượt cho tin quan
 * trọng hơn vẫn còn cơ hội ở nhịp sau.
 */
export function milestoneFor(
  previous: TaskMemory | undefined,
  task: AnnounceableTask,
  now: number,
  options: MilestoneOptions = {},
): { milestone: Milestone | null; memory: TaskMemory } {
  const step = options.stepPercent ?? MILESTONE_DEFAULTS.stepPercent;
  const minGap = options.minGapMs ?? MILESTONE_DEFAULTS.minGapMs;

  const bucket = bucketOf(percentOf(task), step);

  if (!previous || previous.state !== task.state) {
    // Ghi luôn bậc hiện tại làm mốc đã đọc: vừa nói "đã tiếp tục" xong mà đọc
    // ngay "50 phần trăm" thì thừa.
    return {
      milestone: stateMilestone(task, previous?.state),
      memory: { state: task.state, percentAnnounced: bucket, at: now },
    };
  }

  const unchanged: TaskMemory = { ...previous };

  if (task.state !== 'downloading') return { milestone: null, memory: unchanged };
  // Không biết kích thước thì phần trăm là con số bịa ra.
  if (!task.size || task.size <= 0) return { milestone: null, memory: unchanged };
  // Mốc 0% không mang tin gì; "bắt đầu tải" đã nói rồi.
  if (bucket <= 0) return { milestone: null, memory: unchanged };
  if (bucket <= previous.percentAnnounced) return { milestone: null, memory: unchanged };
  if (now - previous.at < minGap) return { milestone: null, memory: unchanged };

  return {
    milestone: {
      text: t('a11y_progress', { name: task.filename, percent: bucket }),
      politeness: 'polite',
      kind: 'progress',
    },
    memory: { state: task.state, percentAnnounced: bucket, at: now },
  };
}

/**
 * Giữ bộ nhớ mốc theo id và phát ra vùng live.
 *
 * Luật gộp trong một nhịp: mọi mốc 'state' được nối bằng '. ' thành MỘT câu
 * (assertive nếu có bất kỳ thất bại nào), còn mốc 'progress' chỉ được đọc khi
 * nhịp đó không có mốc trạng thái nào, và chỉ đọc cho một lượt tải.
 */
export class ProgressAnnouncer {
  private readonly memory = new Map<string, TaskMemory>();
  private readonly options: MilestoneOptions;
  /**
   * Lần `update` đầu chỉ ghi nhớ chứ không đọc. Mở trang quản lý đang có mười
   * lượt tải mà đọc cả mười câu thì người dùng bỏ đi trước khi nghe hết.
   */
  private primed = false;

  constructor(options: MilestoneOptions = {}) {
    this.options = options;
  }

  update(tasks: readonly AnnounceableTask[], now: number = Date.now()): void {
    const step = this.options.stepPercent ?? MILESTONE_DEFAULTS.stepPercent;

    if (!this.primed) {
      this.primed = true;
      for (const task of tasks) {
        this.memory.set(task.id, {
          state: task.state,
          percentAnnounced: bucketOf(percentOf(task), step),
          at: now,
        });
      }
      return;
    }

    const stateTexts: string[] = [];
    const stateMemories = new Map<string, TaskMemory>();
    let assertive = false;
    let progress: { id: string; milestone: Milestone; memory: TaskMemory } | null = null;

    for (const task of tasks) {
      const { milestone, memory } = milestoneFor(
        this.memory.get(task.id),
        task,
        now,
        this.options,
      );
      if (!milestone) continue;

      if (milestone.kind === 'state') {
        stateTexts.push(milestone.text);
        if (milestone.politeness === 'assertive') assertive = true;
        stateMemories.set(task.id, memory);
      } else if (!progress) {
        progress = { id: task.id, milestone, memory };
      }
    }

    if (stateTexts.length) {
      announce(stateTexts.join('. '), assertive ? 'assertive' : 'polite');
      for (const [id, memory] of stateMemories) this.memory.set(id, memory);
    } else if (progress) {
      announce(progress.milestone.text, progress.milestone.politeness);
      this.memory.set(progress.id, progress.memory);
    }

    // Quên các lượt đã biến mất, nếu không bộ nhớ phình mãi trên trang quản lý
    // vốn mở cả ngày.
    const alive = new Set(tasks.map((task) => task.id));
    for (const id of this.memory.keys()) if (!alive.has(id)) this.memory.delete(id);
  }

  forget(id: string): void {
    this.memory.delete(id);
  }

  reset(): void {
    this.memory.clear();
    this.primed = false;
  }
}

/* ---------- Focus ---------- */

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function isVisible(node: HTMLElement): boolean {
  // getClientRects rỗng bắt được cả `hidden`, `display:none` lẫn cha bị ẩn,
  // mà không phải gọi getComputedStyle cho từng nút.
  return !node.hidden && node.getClientRects().length > 0;
}

function firstFocusable(container: ParentNode): HTMLElement | null {
  for (const node of queryAll<HTMLElement>(container, FOCUSABLE)) {
    if (isVisible(node)) return node;
  }
  return null;
}

export function isFocusWithin(container: Node): boolean {
  const active = document.activeElement;
  if (!active || active === document.body) return false;
  return container.contains(active);
}

/**
 * Chạy `mutate` rồi cứu focus.
 *
 * Cần thiết vì danh sách tải xóa hàng ngay dưới chân người dùng: bấm Hủy bằng
 * bàn phím làm nút đó biến mất, focus rơi về body, và người dùng bàn phím mất
 * hẳn vị trí — phải Tab lại từ đầu trang.
 */
export function preserveFocus<T>(
  container: HTMLElement,
  mutate: () => T,
  fallback?: () => HTMLElement | null,
): T {
  const had = isFocusWithin(container);
  const result = mutate();
  if (!had) return result;

  const active = document.activeElement;
  if (active && active !== document.body && container.contains(active)) return result;

  const target = fallback?.() ?? firstFocusable(container) ?? container;
  // Container thường không tự focus được; -1 cho phép focus bằng script mà
  // không thêm một điểm dừng Tab mới.
  if (target === container && !container.hasAttribute('tabindex')) container.tabIndex = -1;
  target.focus();
  return result;
}

export function focusFirst(container: ParentNode): boolean {
  const target = firstFocusable(container);
  if (!target) return false;
  target.focus();
  return true;
}

let generatedIds = 0;

function ensureId(node: HTMLElement, prefix: string): string {
  if (!node.id) {
    generatedIds += 1;
    node.id = `${prefix}-${generatedIds}`;
  }
  return node.id;
}

/**
 * Gắn tên và mô tả cho control không có nhãn nhìn thấy được — công tắc bật/tắt
 * và ô nhập URL trong dự án này đều thuộc loại đó: chữ mô tả nằm ở div anh em
 * nên trình đọc màn hình không nối được với control.
 */
export function labelControl(
  control: HTMLElement,
  spec: { label?: string; labelledBy?: HTMLElement; describedBy?: HTMLElement },
): void {
  if (spec.label !== undefined) control.setAttribute('aria-label', spec.label);
  if (spec.labelledBy) control.setAttribute('aria-labelledby', ensureId(spec.labelledBy, 'df-lbl'));
  if (spec.describedBy) {
    control.setAttribute('aria-describedby', ensureId(spec.describedBy, 'df-desc'));
  }
}

/** Span ẩn khỏi mắt nhưng trình đọc vẫn thấy. Style đặt inline nên không phụ thuộc style.css. */
export function visuallyHidden(content: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = 'sr-only';
  span.textContent = content;
  hideVisually(span);
  return span;
}

/* ---------- Bàn phím cho danh sách ---------- */

export interface RovingListOptions {
  /** Selector của hàng, ví dụ '.task'. tabindex do chính hàm này đặt. */
  itemSelector: string;
  /** Cho phép vòng từ cuối về đầu. */
  wrap?: boolean;
}

function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * Phím mũi tên đi giữa các hàng (roving tabindex), còn các nút bên trong hàng
 * giữ nguyên thứ tự Tab tự nhiên.
 *
 * Cố tình KHÔNG đặt tabindex=-1 cho các nút để Tab bỏ qua chúng: làm vậy thì
 * người dùng bàn phím không chuyên — không dùng trình đọc màn hình, không biết
 * mẫu roving — sẽ không có cách nào tới được nút Tạm dừng. Hai lối đi song song
 * tốn vài lần Tab nhưng không làm ai kẹt.
 *
 * Gọi `refresh()` sau mỗi lần vẽ lại danh sách.
 */
export function installRovingList(
  container: HTMLElement,
  options: RovingListOptions,
): { refresh(): void; destroy(): void } {
  const { itemSelector, wrap = false } = options;
  let index = 0;

  const items = (): HTMLElement[] => queryAll<HTMLElement>(container, itemSelector);

  function apply(list: readonly HTMLElement[]): void {
    if (!list.length) return;
    index = Math.min(Math.max(index, 0), list.length - 1);
    list.forEach((item, i) => {
      item.tabIndex = i === index ? 0 : -1;
    });
  }

  function move(to: number | 'first' | 'last'): void {
    const list = items();
    if (!list.length) return;

    let next: number;
    if (to === 'first') next = 0;
    else if (to === 'last') next = list.length - 1;
    else {
      next = index + to;
      if (next < 0) next = wrap ? list.length - 1 : 0;
      else if (next >= list.length) next = wrap ? 0 : list.length - 1;
    }

    index = next;
    apply(list);
    list[next]?.focus();
  }

  const offKeydown = on(container, 'keydown', (ev) => {
    // Không cướp phím mũi tên của ô nhập liệu nằm trong container.
    if (isTextEntry(ev.target)) return;
    switch (ev.key) {
      case 'ArrowDown':
        move(1);
        break;
      case 'ArrowUp':
        move(-1);
        break;
      case 'Home':
        move('first');
        break;
      case 'End':
        move('last');
        break;
      default:
        return;
    }
    // Chỉ chặn cuộn trang sau khi đã chắc là ta xử lý phím này.
    ev.preventDefault();
  });

  // Chuột bấm vào hàng nào thì hàng đó thành điểm dừng Tab, để lần Tab sau
  // quay lại đúng chỗ người dùng vừa rời đi.
  const offFocus = on(container, 'focusin', (ev) => {
    const list = items();
    const target = ev.target instanceof Element ? ev.target.closest(itemSelector) : null;
    const at = target ? list.indexOf(target as HTMLElement) : -1;
    if (at >= 0) {
      index = at;
      apply(list);
    }
  });

  apply(items());

  return {
    refresh: () => apply(items()),
    destroy: () => {
      offKeydown();
      offFocus();
    },
  };
}

/* ---------- Chuyển động ---------- */

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

export function prefersReducedMotion(): boolean {
  if (typeof matchMedia !== 'function') return false;
  return matchMedia(REDUCED_MOTION).matches;
}

export function watchReducedMotion(onChange: (reduced: boolean) => void): () => void {
  if (typeof matchMedia !== 'function') return () => {};
  const query = matchMedia(REDUCED_MOTION);
  const listener = (ev: MediaQueryListEvent): void => onChange(ev.matches);
  query.addEventListener('change', listener);
  return () => query.removeEventListener('change', listener);
}

/**
 * Ghi `data-motion="reduced"|"full"` lên `<html>` để CSS bắt được. Cần vì
 * `<progress>` không có value chạy hoạt ảnh vô hạn mà media query trong CSS
 * không tắt nổi — phải có móc để chọn.
 */
export function reflectMotionPreference(): boolean {
  const reduced = prefersReducedMotion();
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.motion = reduced ? 'reduced' : 'full';
  }
  return reduced;
}
