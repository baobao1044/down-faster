/**
 * Lớp bọc `chrome.i18n`.
 *
 * Ba lý do tồn tại của module này:
 *
 * 1. `getMessage` trả về chuỗi rỗng khi thiếu key, nên một key gõ sai làm mất
 *    hẳn chữ trên màn hình mà không báo gì. Ở đây key thiếu rơi về chuỗi dự
 *    phòng, và cùng lắm là hiện ra chính cái key — sai thì thấy ngay và grep ra.
 * 2. Tham số được viết bằng token `{ten}` do ta tự thay, KHÔNG dùng khối
 *    `placeholders` của chrome.i18n. Lý do: `getMessage(key)` gọi không kèm
 *    substitutions sẽ xóa sạch mọi `$NAME$` đã khai báo, nên không thể lấy chuỗi
 *    ra rồi thay tham số ở tầng trên. Token `{ten}` đi qua `getMessage` nguyên
 *    vẹn vì chrome.i18n chỉ để ý ký tự `$`. Đổi lại, messages.json tuyệt đối
 *    không được chứa ký tự `$` — test canh chỗ đó.
 * 3. Module này KHÔNG import `platform/api.ts`, vì file đó chạy
 *    `globalThis.browser ?? globalThis.chrome!` ngay lúc nạp và sẽ ném lỗi
 *    trong Node. Ở đây API trình duyệt được đọc lười, mỗi lần gọi — nhờ vậy
 *    phần logic thuần chạy được trong `node:test` mà không phải giả lập gì.
 */

import { warn } from './log';

declare const __DEV__: boolean;

const DEV = typeof __DEV__ !== 'undefined' ? __DEV__ : true;

export type Substitutions = Readonly<Record<string, string | number>>;

/**
 * Danh sách trắng các thuộc tính dịch được. Đây là danh sách trắng chứ không
 * phải danh sách đen có chủ đích: một dòng trong messages.json không bao giờ
 * đặt được `href`, `src` hay `onclick`, kể cả khi ai đó thêm
 * `data-i18n-onclick` vào HTML.
 */
const ATTRIBUTES = [
  'title',
  'placeholder',
  'alt',
  'aria-label',
  'aria-description',
  'aria-valuetext',
  'label',
] as const;

export const TRANSLATABLE_ATTRIBUTES: readonly string[] = ATTRIBUTES;

const ATTR_TEXT = 'data-i18n';
/** Tham số cho chuỗi đã đặt trên DOM, dạng JSON phẳng. Xem `applyI18n`. */
const ATTR_ARGS = 'data-i18n-args';
const ATTR_PREFIX = 'data-i18n-';

/** Selector sinh từ chính danh sách trắng, nên không có cách nào lệch nhau. */
const SELECTOR = [`[${ATTR_TEXT}]`, ...ATTRIBUTES.map((a) => `[${ATTR_PREFIX}${a}]`)].join(',');

/* ---------- Thay tham số ---------- */

/**
 * Thay `{ten}` bằng tham số cùng tên.
 *
 * Token không có tham số được giữ nguyên chứ không xóa đi: một câu hiện ra
 * "còn {eta}" thì người sửa lỗi biết ngay là quên truyền, còn "còn " thì trông
 * như lỗi hiển thị vu vơ.
 */
export function format(template: string, params?: Substitutions): string {
  if (!params) return template;
  // Tạo mới mỗi lần thay vì dùng hằng số module: regex có cờ /g mang theo
  // lastIndex, và chi phí ở đây không đáng kể so với thao tác DOM đi kèm.
  const token = new RegExp('\\{([a-zA-Z][a-zA-Z0-9_]*)\\}', 'g');
  return template.replace(token, (whole, name: string) => {
    // hasOwnProperty chứ không phải `in`: chặn `{toString}` moi ra hàm của prototype.
    if (!Object.prototype.hasOwnProperty.call(params, name)) return whole;
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}

/* ---------- Tra chuỗi ---------- */

let overrideTable: Readonly<Record<string, string>> | null = null;

/** Nhớ key đã cảnh báo: UI vẽ lại mỗi 400ms, cảnh báo lặp sẽ ngập console. */
const warned = new Set<string>();

function reportMissing(key: string): void {
  if (!DEV || warned.has(key)) return;
  warned.add(key);
  warn('i18n', `thiếu bản dịch cho key "${key}"`);
}

function fromNative(key: string): string | null {
  const g = globalThis as { browser?: typeof chrome; chrome?: typeof chrome };
  const i18n = g.browser?.i18n ?? g.chrome?.i18n;
  if (!i18n?.getMessage) return null;
  try {
    const raw: unknown = i18n.getMessage(key);
    // Phải kiểm cả kiểu lẫn chuỗi rỗng: `getMessage` trả '' khi thiếu key và có
    // thể trả undefined nếu bị gọi sai dạng.
    return typeof raw === 'string' && raw !== '' ? raw : null;
  } catch {
    return null;
  }
}

/** Thứ tự: bảng ghi đè → API trình duyệt → không có. */
function resolve(key: string): string | null {
  const fromTable = overrideTable?.[key];
  if (typeof fromTable === 'string' && fromTable !== '') return fromTable;
  return fromNative(key);
}

/**
 * Tra chuỗi theo key và thay tham số.
 *
 * Thiếu key thì trả `fallback` nếu người gọi có truyền, không thì trả chính cái
 * key. Cố tình không ném lỗi: một key sót sẽ làm trắng cả trang popup, mà i18n
 * không đáng để đánh đổi bằng việc UI chết.
 */
export function t(key: string, params?: Substitutions, fallback?: string): string {
  const raw = resolve(key);
  if (raw !== null) return format(raw, params);
  reportMissing(key);
  return format(fallback ?? key, params);
}

export function hasMessage(key: string): boolean {
  return resolve(key) !== null;
}

/* ---------- Locale và định dạng số ---------- */

/**
 * Mã locale của bảng chuỗi ĐANG dùng, không phải của giao diện trình duyệt.
 *
 * `getUILanguage()` có thể trả `fr-FR` trong khi extension chỉ có vi/en nên chữ
 * thực tế rơi về tiếng Việt — định dạng số theo `fr` cho văn bản tiếng Việt là
 * sai. Đọc mã từ chính bảng chuỗi thì luôn khớp với chữ người dùng đang thấy.
 */
export function currentLocale(): string {
  return resolve('locale_bcp47') ?? 'vi';
}

export function currentDirection(): 'ltr' | 'rtl' {
  return fromNative('@@bidi_dir') === 'rtl' ? 'rtl' : 'ltr';
}

const formatters = new Map<string, Intl.NumberFormat>();

/**
 * `Intl.NumberFormat` gắn theo `currentLocale()`, có nhớ đệm vì UI gọi nó trong
 * vòng vẽ lại mỗi 400ms.
 *
 * Khóa đệm dựng bằng JSON.stringify nên phụ thuộc thứ tự khai báo trường; xấu
 * nhất là có hai mục đệm cho cùng một cấu hình, không sai kết quả.
 */
export function numberFormatter(options?: Intl.NumberFormatOptions): Intl.NumberFormat {
  const locale = currentLocale();
  const cacheKey = `${locale}|${options ? JSON.stringify(options) : ''}`;
  const cached = formatters.get(cacheKey);
  if (cached) return cached;

  let made: Intl.NumberFormat;
  try {
    made = new Intl.NumberFormat(locale, options);
  } catch {
    // Mã locale hỏng (ai đó gõ sai key locale_bcp47) làm Intl ném RangeError.
    // Rơi về locale mặc định của máy còn hơn để cả trang chết vì một dấu chấm.
    made = new Intl.NumberFormat(undefined, options);
  }
  formatters.set(cacheKey, made);
  return made;
}

/* ---------- Áp bản dịch lên DOM ---------- */

/**
 * Tên thuộc tính đích của một `data-i18n-*`, hoặc null nếu không nằm trong danh
 * sách trắng. Tách ra thành hàm thuần để test được phần quyết định.
 */
export function translatedAttributeName(dataAttributeName: string): string | null {
  if (!dataAttributeName.startsWith(ATTR_PREFIX)) return null;
  const name = dataAttributeName.slice(ATTR_PREFIX.length).toLowerCase();
  return TRANSLATABLE_ATTRIBUTES.includes(name) ? name : null;
}

function argsOf(element: Element): Substitutions | undefined {
  const raw = element.getAttribute(ATTR_ARGS);
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return parsed as Substitutions;
  } catch {
    // Tham số hỏng thì dịch chuỗi trần còn hơn bỏ trắng cả node.
    return undefined;
  }
}

function translateElement(element: Element): number {
  let applied = 0;
  const params = argsOf(element);

  const textKey = element.getAttribute(ATTR_TEXT);
  if (textKey) {
    const value = resolve(textKey);
    if (value === null) {
      // Giữ nguyên nội dung sẵn có: thà thấy khoảng trắng còn hơn thấy key.
      reportMissing(textKey);
    } else {
      element.textContent = format(value, params);
      applied += 1;
    }
  }

  for (const attr of ATTRIBUTES) {
    const key = element.getAttribute(`${ATTR_PREFIX}${attr}`);
    if (!key) continue;
    const value = resolve(key);
    if (value === null) {
      reportMissing(key);
      continue;
    }
    element.setAttribute(attr, format(value, params));
    applied += 1;
  }

  return applied;
}

/**
 * Dịch cả cây DOM theo `data-i18n` (đặt textContent) và `data-i18n-<thuộc-tính>`.
 * Tham số cho chuỗi đặt ở `data-i18n-args`, dạng JSON phẳng — nhờ vậy đổi ngôn
 * ngữ giữa chừng vẫn dịch lại đúng câu có tham số.
 *
 * Vì `data-i18n` ghi đè textContent nên chỉ đặt nó lên node lá; đặt lên node có
 * con là element sẽ xóa mất các con đó.
 *
 * Trả về số lượt dịch đã áp (mỗi textContent hoặc mỗi thuộc tính tính một lượt).
 */
export function applyI18n(root: ParentNode = document): number {
  let applied = 0;

  // querySelectorAll không bao giờ trả về chính root, nên phải xét riêng.
  if (root instanceof Element && root.matches(SELECTOR)) applied += translateElement(root);

  for (const element of root.querySelectorAll(SELECTOR)) applied += translateElement(element);

  if (root instanceof Document) {
    const html = root.documentElement;
    html.lang = currentLocale();
    html.dir = currentDirection();
  }

  return applied;
}

/* ---------- Bảng chuỗi tự chọn ---------- */

/**
 * Ghi đè API trình duyệt bằng một bảng chuỗi phẳng. `null` để quay về mặc định.
 * Đây cũng là chỗ nối cho test: Node không có `chrome.i18n` nên không có cách
 * nào khác để kiểm nhánh "có bản dịch".
 */
export function useMessageTable(table: Readonly<Record<string, string>> | null): void {
  overrideTable = table;
  // Bảng mới có thể mang locale khác, mà formatter cũ đã gắn cứng locale cũ.
  formatters.clear();
  warned.clear();
}

/** Chỉ chấp nhận đúng dạng thư mục locale, để không ghép được `../` vào URL. */
const LOCALE_PATTERN = /^[a-z]{2}(_[A-Z]{2})?$/;

function flattenTable(parsed: unknown): Record<string, string> | null {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const table: Record<string, string> = {};
  for (const [key, entry] of Object.entries(parsed as Record<string, unknown>)) {
    const message = (entry as { message?: unknown } | null)?.message;
    if (typeof message === 'string') table[key] = message;
  }
  return Object.keys(table).length ? table : null;
}

/**
 * Nạp `_locales/<locale>/messages.json` rồi dùng làm bảng ghi đè.
 *
 * Cần đường này vì chrome.i18n chọn ngôn ngữ theo giao diện trình duyệt và
 * không có API nào đổi được lúc chạy: người Việt dùng Chrome bản tiếng Anh sẽ
 * thấy giao diện tiếng Anh dù `default_locale` là vi.
 *
 * Trả false và giữ nguyên đường native khi hỏng — `_locales` là thư mục dành
 * riêng của trình duyệt, chưa có tài liệu nào bảo đảm fetch được. Người gọi
 * phải gọi lại `applyI18n()` sau khi await.
 */
export async function loadLocaleOverride(locale: string): Promise<boolean> {
  if (!LOCALE_PATTERN.test(locale)) return false;

  const g = globalThis as { browser?: typeof chrome; chrome?: typeof chrome };
  const runtime = g.browser?.runtime ?? g.chrome?.runtime;
  const url = runtime?.getURL?.(`_locales/${locale}/messages.json`);
  if (!url) return false;

  try {
    const response = await fetch(url);
    if (!response.ok) return false;
    const table = flattenTable(await response.json());
    if (!table) return false;
    useMessageTable(table);
    return true;
  } catch {
    return false;
  }
}
