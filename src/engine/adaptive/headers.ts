/**
 * Kho header của request gốc, và bộ chọn tập header an toàn để phát lại.
 *
 * Rất nhiều link chỉ sống khi kèm đúng Referer/Origin/User-Agent/Cookie của
 * trang phát ra nó. Engine hiện fetch "trần" nên hay ăn 403. Cái bẫy ở đây là
 * tưởng chỉ cần nhét chúng vào `new Headers()` là xong — KHÔNG:
 *
 *   - `Referer` nằm trong forbidden request header. Tùy chọn `referrer` của
 *     fetch chỉ nhận URL same-origin, chuỗi rỗng, hoặc `about:client`; URL khác
 *     origin bị âm thầm hạ xuống "client", mà client của ta là
 *     `chrome-extension://…` nên trình duyệt rốt cuộc không gửi Referer nào cả.
 *     Đặt `referrer: 'https://site/page'` từ extension là một no-op im lặng.
 *   - `Origin`, `Cookie`, `Host`, `Connection`, `TE`, `Transfer-Encoding`,
 *     `Content-Length`, `Sec-*`, `Proxy-*` cũng đều forbidden.
 *   - `User-Agent` đã được bỏ khỏi danh sách forbidden trong spec, nhưng Chrome
 *     vẫn lặng lẽ loại nó khỏi fetch (crbug 571722).
 *
 * Vì vậy module này KHÔNG giả vờ đặt được những header đó. Nó chia header làm
 * hai kênh: cái nào fetch đặt được thì trả về dạng `fetchHeaders`, cái nào phải
 * sửa ở tầng mạng thì trả về dạng dữ liệu thuần (`HeaderRuleSpec`) để background
 * áp bằng declarativeNetRequest session rule — offscreen document chỉ chắc chắn
 * gọi được `chrome.runtime`, nên nó không thể tự làm việc đó.
 */

/**
 * 'fetch'   — đặt thẳng vào Headers được (Authorization, Accept, X-*).
 * 'network' — forbidden với fetch, phải nhờ tầng mạng sửa hộ.
 * 'engine'  — engine tự đặt; phát lại là phá logic Range/validator của chính nó.
 * 'never'   — không bao giờ đụng, để trình duyệt và proxy tự lo.
 */
export type HeaderChannel = 'fetch' | 'network' | 'engine' | 'never';

const NETWORK_ONLY = new Set(['referer', 'origin', 'user-agent', 'cookie']);

const ENGINE_OWNED = new Set([
  'range',
  'if-range',
  'if-none-match',
  'if-match',
  'if-modified-since',
  'if-unmodified-since',
  'accept-encoding',
]);

const NEVER_REPLAY = new Set([
  'host',
  'content-length',
  'connection',
  'keep-alive',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'via',
  'expect',
  'date',
  'dnt',
  'set-cookie',
  'set-cookie2',
  'cookie2',
  'access-control-request-headers',
  'access-control-request-method',
  'permissions-policy',
]);

/** Bí mật đăng nhập: chỉ được phát lại trong đúng origin đã thu được. */
const SECRET_HEADERS = new Set(['authorization', 'cookie', 'x-api-key', 'x-auth-token']);

export function classifyHeader(name: string): HeaderChannel {
  const lower = name.trim().toLowerCase();
  if (lower === '') return 'never';
  if (lower.startsWith('sec-') || lower.startsWith('proxy-')) return 'never';
  if (NEVER_REPLAY.has(lower)) return 'never';
  if (NETWORK_ONLY.has(lower)) return 'network';
  if (ENGINE_OWNED.has(lower)) return 'engine';
  return 'fetch';
}

export interface CapturedHeaders {
  referer: string | null;
  origin: string | null;
  userAgent: string | null;
  cookie: string | null;
  /** Header tự do mà fetch đặt được, ví dụ Authorization hay X-Token. */
  extra: Record<string, string>;
  /** Origin nơi thu được. Dùng để cấm gửi bí mật sang host khác. */
  capturedFrom: string | null;
  capturedAt: number;
}

export function emptyCapture(now: number = Date.now()): CapturedHeaders {
  return {
    referer: null,
    origin: null,
    userAgent: null,
    cookie: null,
    extra: {},
    capturedFrom: null,
    capturedAt: now,
  };
}

function safeUrl(value: string | null | undefined): URL | null {
  if (!value) return null;
  try {
    const u = new URL(value);
    return /^https?:$/.test(u.protocol) ? u : null;
  } catch {
    return null;
  }
}

function originOf(value: string | null | undefined): string | null {
  return safeUrl(value)?.origin ?? null;
}

/**
 * Giá trị header không được chứa ký tự điều khiển: một dấu xuống dòng lọt vào là
 * mở đường cho header injection ở bất cứ tầng nào phía sau.
 */
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001F\\u007F]');

function sanitizeHeaderValue(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (CONTROL_CHARS.test(trimmed)) return null;
  return trimmed;
}

/**
 * Đường rẻ nhất và không cần thêm quyền nào: `downloads.DownloadItem.referrer`
 * có sẵn trên cả Chrome lẫn Firefox, và `contextMenus.onClicked` cho `pageUrl`.
 */
export function captureFromDownloadItem(
  item: { url: string; referrer?: string | null },
  userAgent?: string | null,
  now: number = Date.now(),
): CapturedHeaders {
  const capture = emptyCapture(now);
  const referer = sanitizeHeaderValue(item.referrer ?? null);
  const refUrl = safeUrl(referer);
  if (refUrl) {
    capture.referer = refUrl.href;
    capture.origin = refUrl.origin;
  }
  capture.userAgent = sanitizeHeaderValue(userAgent ?? null);
  // Không có Cookie ở đây, nên "nơi thu được" chỉ dùng để xét Referer; lấy origin
  // của trang gốc, hoặc của chính link nếu không biết trang gốc.
  capture.capturedFrom = refUrl?.origin ?? originOf(item.url);
  return capture;
}

/** Đường bậc cao: `webRequest.onBeforeSendHeaders` (cần quyền webRequest, tùy chọn). */
export function captureFromRequestHeaders(
  list: ReadonlyArray<{ name: string; value?: string }>,
  pageUrl: string | null,
  now: number = Date.now(),
): CapturedHeaders {
  const capture = emptyCapture(now);

  for (const entry of list) {
    const lower = entry.name.trim().toLowerCase();
    const value = sanitizeHeaderValue(entry.value);
    if (value === null) continue;

    switch (lower) {
      case 'referer':
        capture.referer = value;
        break;
      case 'origin':
        capture.origin = value;
        break;
      case 'user-agent':
        capture.userAgent = value;
        break;
      case 'cookie':
        capture.cookie = value;
        break;
      default:
        // Chỉ giữ những gì có ngày phát lại được; phần còn lại vứt ngay tại chỗ
        // để không bao giờ có cơ hội rò ra log.
        if (classifyHeader(lower) === 'fetch') capture.extra[lower] = value;
        break;
    }
  }

  capture.capturedFrom =
    originOf(pageUrl) ?? originOf(capture.origin) ?? originOf(capture.referer);
  return capture;
}

export type RefererMode = 'auto' | 'full' | 'origin' | 'off';

/**
 * Bắt chước chính sách `strict-origin-when-cross-origin` mà trình duyệt dùng
 * mặc định: cùng origin thì gửi cả đường dẫn, khác origin thì chỉ gửi origin, và
 * hạ cấp https xuống http thì không gửi gì. Server chống hotlink hầu hết chỉ so
 * origin, nên gửi thừa đường dẫn chỉ là rò rỉ thông tin duyệt web vô ích.
 */
export function synthesizeFromReferrer(
  referrer: string | null,
  targetUrl: string,
  mode: RefererMode = 'auto',
): { referer: string | null; origin: string | null } {
  const none = { referer: null, origin: null };
  if (mode === 'off') return none;

  const ref = safeUrl(referrer);
  if (!ref) return none;

  const target = safeUrl(targetUrl);
  if (!target) return none;

  // Fragment và userinfo không bao giờ được đi kèm Referer.
  ref.hash = '';
  ref.username = '';
  ref.password = '';

  const originOnly = `${ref.origin}/`;
  if (mode === 'origin') return { referer: originOnly, origin: ref.origin };
  if (mode === 'full') return { referer: ref.href, origin: ref.origin };

  if (ref.origin === target.origin) return { referer: ref.href, origin: ref.origin };
  if (ref.protocol === 'https:' && target.protocol === 'http:') return none;
  return { referer: originOnly, origin: ref.origin };
}

export type ReplayTier = 0 | 1 | 2 | 3;

export interface ReplayPlan {
  tier: ReplayTier;
  fetchHeaders: Record<string, string>;
  networkHeaders: Array<{ header: string; operation: 'set' | 'remove'; value?: string }>;
  /** Vì sao một header bị bỏ. Lý do tiếng Việt, để log nói được ra chuyện gì xảy ra. */
  dropped: Array<{ header: string; reason: string }>;
}

/**
 * Leo thang theo bậc thay vì luôn gửi tối đa.
 *
 * Bậc 0 giữ nguyên hành vi hiện tại. Chỉ khi ăn 401/403/451 mới leo lên bậc kế
 * và thử lại. Gửi Referer bịa cho một server không cần nó là thêm một biến số có
 * thể làm hỏng lượt tải đang chạy tốt.
 */
export function planReplay(
  captured: CapturedHeaders,
  targetUrl: string,
  tier: ReplayTier,
  mode: RefererMode = 'auto',
): ReplayPlan {
  const plan: ReplayPlan = { tier, fetchHeaders: {}, networkHeaders: [], dropped: [] };
  if (tier <= 0) return plan;

  const targetOrigin = originOf(targetUrl);
  const sameAsCapture =
    targetOrigin !== null &&
    captured.capturedFrom !== null &&
    targetOrigin === captured.capturedFrom;

  const crossOriginSecret =
    'chỉ phát lại bí mật trong đúng origin đã thu được, tránh rò đăng nhập sang host khác';

  /* Bậc 1: những gì fetch() thật sự đặt được. */
  for (const [name, value] of Object.entries(captured.extra)) {
    const lower = name.toLowerCase();
    const channel = classifyHeader(lower);
    if (channel !== 'fetch') {
      plan.dropped.push({ header: lower, reason: `kênh '${channel}', fetch không đặt được` });
      continue;
    }
    const clean = sanitizeHeaderValue(value);
    if (clean === null) {
      plan.dropped.push({ header: lower, reason: 'giá trị rỗng hoặc chứa ký tự điều khiển' });
      continue;
    }
    if (SECRET_HEADERS.has(lower) && !sameAsCapture) {
      plan.dropped.push({ header: lower, reason: crossOriginSecret });
      continue;
    }
    plan.fetchHeaders[lower] = clean;
  }

  /* Bậc 2: Referer và Origin — forbidden với fetch, phải nhờ tầng mạng. */
  if (tier >= 2) {
    const { referer, origin } = synthesizeFromReferrer(captured.referer, targetUrl, mode);
    if (referer) {
      plan.networkHeaders.push({ header: 'referer', operation: 'set', value: referer });
    } else {
      plan.dropped.push({
        header: 'referer',
        reason: captured.referer
          ? 'chính sách referrer không cho gửi sang đích này'
          : 'không bắt được Referer của request gốc',
      });
    }
    if (origin) {
      plan.networkHeaders.push({ header: 'origin', operation: 'set', value: origin });
    }
  }

  /* Bậc 3: User-Agent và Cookie — bậc cuối, chỉ dùng khi mọi cách khác đã thua. */
  if (tier >= 3) {
    if (captured.userAgent) {
      plan.networkHeaders.push({
        header: 'user-agent',
        operation: 'set',
        value: captured.userAgent,
      });
    } else {
      plan.dropped.push({ header: 'user-agent', reason: 'không bắt được User-Agent gốc' });
    }

    if (captured.cookie) {
      if (sameAsCapture) {
        plan.networkHeaders.push({
          header: 'cookie',
          operation: 'set',
          value: captured.cookie,
        });
      } else {
        plan.dropped.push({ header: 'cookie', reason: crossOriginSecret });
      }
    }
  }

  return plan;
}

/**
 * Gặp 401/403/451 thì leo bậc; null nghĩa là hết bài và đã đến lúc trả lượt tải
 * về cho trình duyệt, nơi cookie jar và Referer thật vẫn còn nguyên.
 */
export function nextTier(current: ReplayTier, status: number, hasCapture: boolean): ReplayTier | null {
  if (status !== 401 && status !== 403 && status !== 451) return null;
  if (!hasCapture) return null;
  if (current >= 3) return null;
  return (current + 1) as ReplayTier;
}

export interface HeaderRuleSpec {
  id: number;
  /** null khi URL chứa ký tự có nghĩa đặc biệt trong cú pháp lọc của DNR. */
  urlFilter: string | null;
  /** Phương án thu hẹp thay thế khi urlFilter phải bỏ. */
  requestDomains: string[] | null;
  /** [-1] = chỉ request không thuộc tab nào, tức là request của chính engine. */
  tabIds: number[] | null;
  requestHeaders: Array<{ header: string; operation: 'set' | 'remove' | 'append'; value?: string }>;
}

/** `*`, `^` và `|` là ký tự điều khiển của cú pháp urlFilter, không phải chữ thường. */
const DNR_SPECIAL = /[*^|]/;
const ASCII_PRINTABLE = /^[\x20-\x7E]+$/;

/**
 * Bọc URL bằng `|…|` để khớp chính xác, và cố tình KHÔNG dùng resourceTypes:
 * fetch phát từ dedicated worker của offscreen có thể được xếp là
 * `xmlhttprequest` hoặc `other` tùy phiên bản, liệt kê thiếu là rule im lặng
 * không khớp — triệu chứng y hệt "DNR không áp cho request của chính extension"
 * nên cực khó chẩn đoán.
 */
export function buildRuleSpec(id: number, targetUrl: string, plan: ReplayPlan): HeaderRuleSpec | null {
  if (plan.networkHeaders.length === 0) return null;

  let urlFilter: string | null = null;
  let requestDomains: string[] | null = null;

  if (ASCII_PRINTABLE.test(targetUrl) && !DNR_SPECIAL.test(targetUrl)) {
    urlFilter = `|${targetUrl}|`;
  } else {
    const host = safeUrl(targetUrl)?.hostname ?? null;
    if (!host) return null;
    requestDomains = [host];
  }

  return {
    id,
    urlFilter,
    requestDomains,
    tabIds: [-1],
    requestHeaders: plan.networkHeaders.map((h) => ({
      header: h.header,
      operation: h.operation,
      ...(h.value === undefined ? {} : { value: h.value }),
    })),
  };
}

/** Dải id riêng, đủ xa để không giẫm lên rule tĩnh mà ai đó thêm sau này. */
export const RULE_ID_BASE = 720000;
export const RULE_ID_SPAN = 256;

/** Toàn dải id, để background dọn sạch rule sót lại lúc khởi động. */
export function allRuleIds(): number[] {
  const ids: number[] = [];
  for (let i = 0; i < RULE_ID_SPAN; i++) ids.push(RULE_ID_BASE + i);
  return ids;
}

export class RuleIdAllocator {
  private readonly byTask = new Map<string, number>();
  private readonly used = new Set<number>();

  /**
   * Ném lỗi khi hết dải thay vì tái dùng id của job khác: dùng lại một id đang
   * sống sẽ ghi đè rule của job đó và làm nó ăn 403 một cách bí ẩn.
   */
  take(taskId: string): number {
    const existing = this.byTask.get(taskId);
    if (existing !== undefined) return existing;

    for (let i = 0; i < RULE_ID_SPAN; i++) {
      const id = RULE_ID_BASE + i;
      if (this.used.has(id)) continue;
      this.used.add(id);
      this.byTask.set(taskId, id);
      return id;
    }
    throw new Error(`Hết id rule (${RULE_ID_SPAN} chỗ), không cấp thêm được`);
  }

  release(taskId: string): void {
    const id = this.byTask.get(taskId);
    if (id === undefined) return;
    this.byTask.delete(taskId);
    this.used.delete(id);
  }

  /** Những id đang được cấp phát ngay lúc này. */
  all(): number[] {
    return [...this.used].sort((a, b) => a - b);
  }
}

interface StoreEntry {
  captured: CapturedHeaders;
  at: number;
}

/**
 * Kho header theo URL.
 *
 * CỐ Ý chỉ nằm trong RAM và có TTL ngắn: chuỗi Cookie là bí mật đăng nhập, ghi
 * nó xuống chrome.storage là biến một tiện ích tải file thành một kho mật khẩu.
 */
export class HeaderStore {
  private readonly map = new Map<string, StoreEntry>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly nowFn: () => number;

  constructor(opts: { maxEntries?: number; ttlMs?: number; now?: () => number } = {}) {
    this.maxEntries = Math.max(1, opts.maxEntries ?? 32);
    this.ttlMs = Math.max(1000, opts.ttlMs ?? 10 * 60 * 1000);
    this.nowFn = opts.now ?? (() => Date.now());
  }

  get size(): number {
    return this.map.size;
  }

  remember(url: string, captured: CapturedHeaders): void {
    const key = this.keyOf(url);
    if (key === null) return;

    // Xóa trước khi đặt để Map giữ đúng thứ tự "mới nhất ở cuối", nhờ vậy đuổi
    // mục cũ nhất chỉ là lấy khóa đầu tiên.
    this.map.delete(key);
    this.map.set(key, { captured, at: this.nowFn() });

    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
  }

  /** Khớp chính xác URL trước; không có thì lui về cùng origin và thư mục cha. */
  lookup(url: string): CapturedHeaders | null {
    this.prune();

    const key = this.keyOf(url);
    if (key === null) return null;

    const exact = this.map.get(key);
    if (exact) return exact.captured;

    const target = safeUrl(url);
    if (!target) return null;

    let best: { captured: CapturedHeaders; depth: number } | null = null;
    for (const [storedKey, entry] of this.map) {
      const stored = safeUrl(storedKey);
      if (!stored || stored.origin !== target.origin) continue;
      // Thư mục chứa file: cắt phần tên file khỏi đường dẫn.
      const dir = stored.pathname.replace(/[^/]*$/, '');
      if (!target.pathname.startsWith(dir)) continue;
      // `>=` để mục ghi sau thắng khi cùng độ sâu: Map duyệt theo thứ tự chèn nên
      // đây chính là bản bắt được gần đây nhất, tức là bản còn hợp lệ hơn.
      if (!best || dir.length >= best.depth) best = { captured: entry.captured, depth: dir.length };
    }
    return best?.captured ?? null;
  }

  forget(url: string): void {
    const key = this.keyOf(url);
    if (key !== null) this.map.delete(key);
  }

  prune(): number {
    const now = this.nowFn();
    const stale: string[] = [];
    for (const [key, entry] of this.map) {
      if (now - entry.at >= this.ttlMs) stale.push(key);
    }
    for (const key of stale) this.map.delete(key);
    return stale.length;
  }

  private keyOf(url: string): string | null {
    const u = safeUrl(url);
    if (!u) return null;
    // Fragment không bao giờ đi tới server nên không phải là một phần định danh.
    u.hash = '';
    return u.href;
  }
}

const MASK = '«đã che»';

/** Che bí mật trước khi bất cứ thứ gì trong này chạm tới console. */
export function redact(captured: CapturedHeaders): Record<string, string> {
  const out: Record<string, string> = {
    referer: captured.referer ?? '—',
    origin: captured.origin ?? '—',
    userAgent: captured.userAgent ? `${captured.userAgent.slice(0, 24)}…` : '—',
    cookie: captured.cookie ? `${MASK} (${captured.cookie.length} ký tự)` : '—',
    capturedFrom: captured.capturedFrom ?? '—',
  };
  for (const [name, value] of Object.entries(captured.extra)) {
    out[`extra.${name}`] = SECRET_HEADERS.has(name.toLowerCase()) ? MASK : value;
  }
  return out;
}
