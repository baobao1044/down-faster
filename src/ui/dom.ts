/**
 * Bộ dựng DOM nhỏ dùng chung cho popup, trang quản lý và màn hình chào.
 *
 * QUY TẮC BẤT DI BẤT DỊCH: module này không bao giờ chạm `innerHTML`,
 * `outerHTML` hay `insertAdjacentHTML`. Tên file đi qua đây là do server đặt và
 * hiện thẳng lên màn hình; chỉ cần một đường ghi HTML là mọi chỗ dựng tên file
 * thành chỗ chèn mã. Không có đường đó thì không phải nhớ lọc ở từng chỗ gọi.
 *
 * Ngoài ra module gom luôn mấy chỗ ép kiểu lặp đi lặp lại
 * (`document.getElementById(...) as HTMLInputElement`) thành `byId<T>()`, vốn
 * ném lỗi có tên id thay vì trả null ngầm rồi chết ở dòng khác.
 */

import { format, t, type Substitutions } from '../shared/i18n';
import { warn } from '../shared/log';

export type Child = Node | string | number | null | undefined | false;

type Handlers<K extends keyof HTMLElementTagNameMap> = {
  [E in keyof HTMLElementEventMap]?: (
    this: HTMLElementTagNameMap[K],
    ev: HTMLElementEventMap[E],
  ) => void;
};

export interface ElementSpec<K extends keyof HTMLElementTagNameMap> {
  class?: string | readonly (string | false | null | undefined)[];
  /** Đặt qua textContent. Loại trừ lẫn nhau với `i18n`. */
  text?: string | number;
  /** Key i18n cho textContent. Ghi kèm data-i18n để đổi ngôn ngữ dịch lại được. */
  i18n?: string;
  i18nParams?: Substitutions;
  id?: string;
  role?: string;
  hidden?: boolean;
  tabIndex?: number;
  attrs?: Readonly<Record<string, string | number | boolean | null | undefined>>;
  data?: Readonly<Record<string, string>>;
  on?: Handlers<K>;
  children?: readonly Child[];
}

export function text(value: string | number): Text {
  return document.createTextNode(String(value));
}

/** So sánh tường minh chứ không dùng `!child`: số 0 là nội dung hợp lệ. */
function isRenderable(child: Child): child is Node | string | number {
  return child !== null && child !== undefined && child !== false;
}

function appendChildren(parent: Node, children: readonly Child[]): void {
  for (const child of children) {
    if (!isRenderable(child)) continue;
    parent.appendChild(child instanceof Node ? child : text(child));
  }
}

export function frag(...children: readonly Child[]): DocumentFragment {
  const fragment = document.createDocumentFragment();
  appendChildren(fragment, children);
  return fragment;
}

/**
 * Gỡ thuộc tính khi giá trị là null/undefined, ngược lại đặt `String(value)`.
 *
 * `false` cũng gỡ, vì với thuộc tính HTML thường thì có mặt đã là bật —
 * `disabled="false"` vẫn khóa nút.
 *
 * NGOẠI LỆ là `aria-*`: ở đó vắng mặt và `"false"` là hai điều khác nhau.
 * `aria-expanded` không có nghĩa là "phần này không mở ra được", còn
 * `aria-expanded="false"` nghĩa là "đang đóng"; gỡ đi thì trình đọc màn hình im
 * lặng thay vì nói "đã thu gọn". Cùng chuyện với aria-pressed, aria-checked,
 * aria-selected. Riêng `aria-hidden="false"` thì trùng nghĩa với vắng mặt nên
 * viết ra cũng không hại gì.
 */
export function setAttr(
  node: Element,
  name: string,
  value: string | number | boolean | null | undefined,
): void {
  if (value === null || value === undefined) node.removeAttribute(name);
  else if (value === false && !name.startsWith('aria-')) node.removeAttribute(name);
  else node.setAttribute(name, String(value));
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  spec: ElementSpec<K> = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);

  if (spec.class !== undefined) {
    const list = typeof spec.class === 'string' ? [spec.class] : spec.class;
    const names = list.filter((c): c is string => typeof c === 'string' && c !== '');
    if (names.length) node.className = names.join(' ');
  }

  if (spec.i18n !== undefined) {
    node.textContent = t(spec.i18n, spec.i18nParams);
    node.setAttribute('data-i18n', spec.i18n);
    // Tham số phải nằm lại trên DOM, nếu không applyI18n() lần sau sẽ dịch ra
    // câu còn nguyên token `{ten}`.
    if (spec.i18nParams) node.setAttribute('data-i18n-args', JSON.stringify(spec.i18nParams));
  } else if (spec.text !== undefined) {
    node.textContent = String(spec.text);
  }

  if (spec.id !== undefined) node.id = spec.id;
  if (spec.role !== undefined) node.setAttribute('role', spec.role);
  if (spec.hidden !== undefined) node.hidden = spec.hidden;
  if (spec.tabIndex !== undefined) node.tabIndex = spec.tabIndex;

  if (spec.attrs) {
    for (const [name, value] of Object.entries(spec.attrs)) setAttr(node, name, value);
  }

  if (spec.data) {
    for (const [name, value] of Object.entries(spec.data)) node.dataset[name] = value;
  }

  if (spec.on) {
    // Object.entries làm mất liên hệ giữa tên sự kiện và kiểu tham số; kiểu đã
    // được `Handlers<K>` canh ở chỗ gọi nên ép về EventListener ở đây là an toàn.
    for (const [type, handler] of Object.entries(spec.on) as [string, EventListener][]) {
      if (handler) node.addEventListener(type, handler);
    }
  }

  if (spec.children) {
    // `data-i18n` ghi đè trọn textContent, nên lần applyI18n() sau sẽ xóa sạch
    // đám con vừa gắn ở đây. Bẫy này chỉ lộ ra khi người dùng đổi ngôn ngữ, tức
    // là muộn hơn hẳn lúc viết code — nên báo ngay tại chỗ dựng.
    if (spec.i18n !== undefined && spec.children.some(isRenderable)) {
      warn('dom', `el('${tag}') vừa đặt i18n vừa có con — applyI18n() lần sau sẽ xóa mất các con`);
    }
    appendChildren(node, spec.children);
  }

  return node;
}

/**
 * Xóa sạch con.
 *
 * Về giải phóng bộ nhớ thì cách này và `textContent = ''` là một: listener gắn
 * trên các node con đều chỉ được thu hồi khi chính node con được gom rác. Chọn
 * vòng lặp removeChild vì nó nói đúng việc đang làm — `textContent = ''` trông
 * như thao tác trên chữ nên dễ bị người sau đọc nhầm là chỉ xóa text node.
 */
export function clear(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/**
 * Chỉ ghi khi khác giá trị cũ, trả true nếu có đổi.
 *
 * Quan trọng cho trợ năng: ghi lại đúng chuỗi cũ vẫn là một thay đổi DOM, và
 * trong vùng aria-live nó khiến trình đọc màn hình đọc lại câu vừa đọc xong.
 */
export function setText(node: Node, value: string | number): boolean {
  const next = String(value);
  if (node.textContent === next) return false;
  node.textContent = next;
  return true;
}

export function setHidden(node: HTMLElement, hidden: boolean): void {
  if (node.hidden !== hidden) node.hidden = hidden;
}

export function setClass(node: Element, name: string, on: boolean): void {
  node.classList.toggle(name, on);
}

/** Đặt textContent từ bảng chuỗi, giữ lại key và tham số cho lần dịch sau. */
export function setI18nText(node: Element, key: string, params?: Substitutions): void {
  node.setAttribute('data-i18n', key);
  if (params) node.setAttribute('data-i18n-args', JSON.stringify(params));
  else node.removeAttribute('data-i18n-args');
  setText(node, t(key, params));
}

export function byId<T extends HTMLElement = HTMLElement>(
  id: string,
  root: Document | DocumentFragment = document,
): T {
  const node = root.getElementById(id);
  if (!node) throw new Error(`Không tìm thấy phần tử #${id}`);
  return node as T;
}

export function query<T extends Element = Element>(root: ParentNode, selector: string): T {
  const node = root.querySelector<T>(selector);
  if (!node) throw new Error(`Không tìm thấy phần tử khớp "${selector}"`);
  return node;
}

export function queryAll<T extends Element = Element>(root: ParentNode, selector: string): T[] {
  return Array.from(root.querySelectorAll<T>(selector));
}

/**
 * Gắn listener và trả về hàm gỡ. Hàng tải bị xóa khỏi danh sách thường xuyên,
 * và giữ sẵn hàm gỡ rẻ hơn nhiều so với nhớ lại đúng cặp (type, handler) sau này.
 */
export function on<E extends keyof HTMLElementEventMap>(
  target: EventTarget,
  type: E,
  handler: (ev: HTMLElementEventMap[E]) => void,
  options?: AddEventListenerOptions,
): () => void {
  const listener = handler as EventListener;
  target.addEventListener(type, listener, options);
  return () => target.removeEventListener(type, listener, options);
}

/** Một khung hình, để hoãn thao tác focus tới sau khi DOM đã ổn định. */
export function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

/** Tiện cho chỗ chỉ cần thay tham số mà không tra bảng chuỗi. */
export { format };
