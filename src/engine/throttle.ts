/**
 * Giới hạn tốc độ tải bằng một xô token duy nhất, dùng chung cho mọi fetch worker.
 *
 * Trong trình duyệt không có cách nào bóp băng thông ở tầng socket, nên cách duy
 * nhất là ngừng gọi `reader.read()` để backpressure lan xuống TCP. Vì vậy hạn mức
 * ở đây là con số trung bình trên khoảng một giây, không phải tức thời.
 *
 * Xô nằm ở phía host (ThrottleServer) và cấp hạn mức theo lô cho từng worker
 * (ThrottleClient) qua postMessage. Cố tình KHÔNG dùng SharedArrayBuffer +
 * Atomics.wait: chặn vòng lặp message của fetch worker sẽ khóa chết luôn đường
 * nhận WriteAck từ writer, mà van điều áp của worker lại đang phụ thuộc vào đó.
 */

/** Giá trị byte của một grant mang nghĩa "từ giờ khỏi hỏi nữa". */
export const UNLIMITED = -1;
/** Trần tích lũy của xô, tính bằng giây tốc độ: chặn cú xả ồ ạt sau khi timer trễ. */
export const DEFAULT_CAPACITY_SECONDS = 1;
/** Một lô hạn mức phủ khoảng thời gian này của tổng băng thông. */
export const GRANT_WINDOW_MS = 100;
export const MIN_GRANT = 16 * 1024;
export const MAX_GRANT = 4 * 1024 * 1024;
/** Dưới mức này thì một kết nối nằm im quá lâu giữa hai lô và dễ bị CDN đóng. */
export const MIN_RATE_PER_CONNECTION = 256 * 1024;

/* ---------- Thông điệp qua ranh giới worker ---------- */

export interface QuotaRequest {
  type: 'quota:need';
}

/** bytes < 0 nghĩa là bỏ giới hạn hoàn toàn. */
export interface QuotaGrant {
  type: 'quota:grant';
  bytes: number;
}

/** Rate không hợp lệ hoặc <= 0 đều quy về 0 = không giới hạn. */
function normalizeRate(rate: number): number {
  return Number.isFinite(rate) && rate > 0 ? rate : 0;
}

/* ---------- Xô token thuần ---------- */

export interface TokenBucketOptions {
  ratePerSecond: number;
  capacity?: number;
  now?: () => number;
}

/**
 * Token được tính lại từ đồng hồ tường mỗi lần chạm vào, chứ không cộng dồn theo
 * nhịp timer. Offscreen document là một trang ẩn nên setTimeout ở đó có thể bị
 * bóp nhịp; tính theo đồng hồ nghĩa là timer trễ chỉ làm dữ liệu về giật hơn chứ
 * không làm sai tốc độ trung bình.
 */
export class TokenBucket {
  private readonly clock: () => number;
  private readonly fixedCapacity: number | null;
  private rate: number;
  private cap: number;
  private tokens: number;
  private last: number;

  constructor(options: TokenBucketOptions) {
    this.clock = options.now ?? Date.now;
    this.fixedCapacity =
      typeof options.capacity === 'number' && options.capacity > 0 ? options.capacity : null;
    this.rate = normalizeRate(options.ratePerSecond);
    this.cap = this.capacityFor(this.rate);
    // Khởi tạo đầy xô: một file nhỏ tải xong trong nửa giây không đáng bị phạt
    // chỉ vì nó xui xẻo bắt đầu ngay sau khi người dùng bật giới hạn.
    this.tokens = this.cap;
    this.last = this.clock();
  }

  get unlimited(): boolean {
    return this.rate <= 0;
  }

  get ratePerSecond(): number {
    return this.rate;
  }

  get capacity(): number {
    return this.cap;
  }

  setRate(ratePerSecond: number): void {
    const next = normalizeRate(ratePerSecond);
    if (next === this.rate) return;

    this.refill();
    const wasUnlimited = this.rate <= 0;
    this.rate = next;
    this.cap = this.capacityFor(next);
    // Từ không giới hạn siết lại thì bắt đầu bằng xô đầy: cho phép đúng một giây
    // đà cũ rồi mới ép về mức mới, thay vì chặn đứng các dòng đang chạy.
    this.tokens = wasUnlimited ? this.cap : Math.min(this.tokens, this.cap);
    this.last = this.clock();
  }

  /** Nạp theo thời gian đã trôi rồi trả số byte hiện có. */
  available(): number {
    if (this.unlimited) return Number.POSITIVE_INFINITY;
    this.refill();
    return this.tokens;
  }

  /** Lấy tối đa `want` byte, trả về số lấy được (có thể 0). */
  take(want: number): number {
    if (want <= 0) return 0;
    if (this.unlimited) return want;
    this.refill();
    const got = Math.floor(Math.min(want, this.tokens));
    if (got <= 0) return 0;
    this.tokens -= got;
    return got;
  }

  /** Số mili-giây phải chờ để đủ `want` byte; 0 nghĩa là có ngay. */
  waitFor(want: number): number {
    if (this.unlimited || want <= 0) return 0;
    this.refill();
    // Xin quá trần thì chờ bao lâu cũng không đủ, nên quy về đúng trần để bên
    // gọi không kẹt vĩnh viễn ở một con số không bao giờ tới.
    const target = Math.min(want, this.cap);
    if (this.tokens >= target) return 0;
    return Math.ceil(((target - this.tokens) / this.rate) * 1000);
  }

  /**
   * Trần không bao giờ được xuống dưới một byte: take() làm tròn xuống, nên một
   * xô chỉ chứa nổi 0,5 byte là xô không bao giờ phát ra nổi byte nào — bên gọi
   * sẽ hỏi lại mỗi mili-giây mà mãi mãi không được cấp.
   */
  private capacityFor(rate: number): number {
    if (rate <= 0) return 0;
    return Math.max(1, this.fixedCapacity ?? rate * DEFAULT_CAPACITY_SECONDS);
  }

  private refill(): void {
    const now = this.clock();
    const elapsed = now - this.last;
    // Đồng hồ nhảy lùi (chỉnh giờ hệ thống) thì chỉ chốt lại mốc, không trừ token.
    if (elapsed <= 0) {
      this.last = now;
      return;
    }
    this.last = now;
    if (this.rate > 0) {
      this.tokens = Math.min(this.cap, this.tokens + (this.rate * elapsed) / 1000);
    }
  }
}

/* ---------- Trợ giúp thuần ---------- */

/**
 * Kích thước một lô hạn mức.
 *
 * Lô phủ GRANT_WINDOW_MS của tổng băng thông, nhưng không bao giờ lớn hơn phần
 * chia đều của một trần xô: nếu không, với nhiều worker thì một vòng round-robin
 * kéo dài nhiều giây và worker cuối hàng ngồi im đủ lâu để bị server đóng kết nối.
 */
export function grantSize(ratePerSecond: number, clients: number): number {
  const rate = normalizeRate(ratePerSecond);
  if (rate <= 0) return 0;
  const perWindow = (rate * GRANT_WINDOW_MS) / 1000;
  const fairShare = (rate * DEFAULT_CAPACITY_SECONDS) / Math.max(1, clients);
  const size = Math.round(Math.min(perWindow, fairShare));
  return Math.max(MIN_GRANT, Math.min(MAX_GRANT, size));
}

/**
 * Số kết nối nên mở khi đang bị giới hạn tốc độ.
 *
 * Ở 200 KB/s chia cho 8 kết nối, mỗi socket nằm im hàng giây giữa hai lô và dễ bị
 * CDN đóng vì idle, đẩy engine vào vòng retry vô ích — chậm hơn hẳn so với mở ít
 * kết nối mà chạy liên tục.
 */
export function connectionsForRate(ratePerSecond: number, requested: number): number {
  // Math.max(1, NaN) vẫn ra NaN, và số kết nối NaN làm vòng lặp spawn không chạy
  // vòng nào: lượt tải đứng im mà không báo lỗi gì. Chặn ngay tại đây.
  const wanted = Number.isFinite(requested) ? Math.max(1, Math.floor(requested)) : 1;
  const rate = normalizeRate(ratePerSecond);
  if (rate <= 0) return wanted;
  const affordable = Math.max(1, Math.floor(rate / MIN_RATE_PER_CONNECTION));
  return Math.min(wanted, affordable);
}

/* ---------- Phía host ---------- */

export type GrantSender = (grant: QuotaGrant) => void;

export interface TimerPort {
  set(fn: () => void, ms: number): number;
  clear(handle: number): void;
}

const defaultTimer: TimerPort = {
  // Node và trình duyệt trả về hai kiểu handle khác nhau; ở đây chỉ cần một mã
  // đối xứng giữa set và clear nên ép kiểu là an toàn.
  set: (fn, ms) => setTimeout(fn, ms) as unknown as number,
  clear: (handle) => clearTimeout(handle),
};

export interface ThrottleServerOptions {
  ratePerSecond: number;
  now?: () => number;
  timer?: TimerPort;
}

/**
 * Giữ xô chung và phát hạn mức cho các worker đang chờ theo vòng tròn.
 *
 * Một xô cho toàn extension chứ không phải mỗi job một xô: người dùng đặt
 * "500 KB/s" là nói cho cả extension, và xô chung tự san phẳng chênh lệch giữa
 * worker nhanh với worker rơi vào node CDN chậm mà không cần đo đạc gì.
 */
export class ThrottleServer {
  private readonly bucket: TokenBucket;
  private readonly timer: TimerPort;
  private readonly clients = new Map<string, GrantSender>();
  /** Hàng chờ FIFO chính là cơ chế round-robin: cấp xong là xuống cuối hàng. */
  private readonly queue: string[] = [];
  private handle: number | null = null;
  private pumping = false;
  private disposed = false;

  constructor(options: ThrottleServerOptions) {
    this.bucket = new TokenBucket({ ratePerSecond: options.ratePerSecond, now: options.now });
    this.timer = options.timer ?? defaultTimer;
  }

  get unlimited(): boolean {
    return this.bucket.unlimited;
  }

  get attached(): number {
    return this.clients.size;
  }

  get waiting(): number {
    return this.queue.length;
  }

  setRate(ratePerSecond: number): void {
    if (this.disposed) return;
    const wasUnlimited = this.bucket.unlimited;
    this.bucket.setRate(ratePerSecond);

    if (this.bucket.unlimited) {
      if (!wasUnlimited) {
        this.queue.length = 0;
        this.cancelTimer();
        this.broadcast(UNLIMITED);
      }
      return;
    }

    // Bật lại giới hạn giữa chừng: client đang ở chế độ khỏi hỏi cần một cú hích
    // để quay về xin phép, và lô rỗng chính là cú hích đó.
    if (wasUnlimited) this.broadcast(0);
    this.pump();
  }

  attach(clientId: string, send: GrantSender): void {
    if (this.disposed) return;
    this.clients.set(clientId, send);
    // Worker mới sinh ra khi đang không giới hạn thì báo ngay, khỏi tốn một vòng hỏi.
    if (this.bucket.unlimited) send({ type: 'quota:grant', bytes: UNLIMITED });
  }

  detach(clientId: string): void {
    this.clients.delete(clientId);
    const at = this.queue.indexOf(clientId);
    if (at >= 0) this.queue.splice(at, 1);
    if (this.clients.size === 0) this.cancelTimer();
  }

  /** Worker báo hết hạn mức. Cấp ngay nếu còn token, không thì xếp hàng. */
  request(clientId: string): void {
    if (this.disposed) return;
    const send = this.clients.get(clientId);
    // Worker đã chết mà tin nhắn còn trên đường: bỏ qua, đừng giữ chỗ cho nó.
    if (!send) return;

    if (this.bucket.unlimited) {
      send({ type: 'quota:grant', bytes: UNLIMITED });
      return;
    }
    if (!this.queue.includes(clientId)) this.queue.push(clientId);
    this.pump();
  }

  dispose(): void {
    this.disposed = true;
    this.cancelTimer();
    // Nhả mọi bên đang chờ trước khi quên chúng. Server đã thôi cưỡng chế thì
    // hạn mức đúng là vô hạn, còn im lặng ở đây nghĩa là mọi worker đang await
    // hạn mức treo vĩnh viễn — không có gì đánh thức chúng nữa.
    this.broadcast(UNLIMITED);
    this.clients.clear();
    this.queue.length = 0;
  }

  private pump(): void {
    // Client có thể xin lô kế tiếp ngay trong lời gọi send(); chặn đệ quy ở đây
    // để vòng lặp bên ngoài xử lý tiếp thay vì chồng ngăn xếp.
    if (this.pumping || this.disposed) return;
    this.pumping = true;
    try {
      while (this.queue.length > 0 && !this.bucket.unlimited) {
        const want = this.batchSize();
        if (this.bucket.available() < want) {
          this.arm(this.bucket.waitFor(want));
          return;
        }

        const id = this.queue.shift();
        if (id === undefined) break;
        const send = this.clients.get(id);
        if (!send) continue;

        const got = this.bucket.take(want);
        if (got <= 0) {
          // Không nên xảy ra sau khi đã kiểm tra available(), nhưng nếu có thì
          // trả client về đầu hàng chứ đừng cấp lô rỗng làm nó hỏi vòng vòng.
          this.queue.unshift(id);
          this.arm(this.bucket.waitFor(want));
          return;
        }
        send({ type: 'quota:grant', bytes: got });
      }
      this.cancelTimer();
    } finally {
      this.pumping = false;
    }
  }

  /** Không bao giờ xin quá trần xô, nếu không hàng chờ kẹt vĩnh viễn ở rate thấp. */
  private batchSize(): number {
    const ideal = grantSize(this.bucket.ratePerSecond, this.clients.size);
    const ceiling = Math.max(1, Math.floor(this.bucket.capacity));
    return Math.min(ideal, ceiling);
  }

  private broadcast(bytes: number): void {
    for (const send of this.clients.values()) send({ type: 'quota:grant', bytes });
  }

  private arm(ms: number): void {
    this.cancelTimer();
    this.handle = this.timer.set(() => {
      this.handle = null;
      this.pump();
    }, Math.max(1, Math.ceil(ms)));
  }

  private cancelTimer(): void {
    if (this.handle !== null) {
      this.timer.clear(this.handle);
      this.handle = null;
    }
  }
}

/* ---------- Phía worker ---------- */

export interface ThrottleClientOptions {
  ask: () => void;
  limited?: boolean;
}

/**
 * Hạn mức cục bộ của một fetch worker.
 *
 * Không thể biết trước một chunk từ ReadableStream dài bao nhiêu byte, nên worker
 * xin hạn mức TRƯỚC khi đọc rồi trừ đi sau khi đọc xong, và được phép nợ âm. Sai
 * số vì thế bị chặn ở đúng một chunk cho mỗi worker, còn tốc độ trung bình vẫn đúng.
 */
export class ThrottleClient {
  private readonly askFn: () => void;
  private limited: boolean;
  private balance = 0;
  private waiter: (() => void) | null = null;
  private pending: Promise<void> | null = null;

  constructor(options: ThrottleClientOptions) {
    this.askFn = options.ask;
    // Mặc định coi như có giới hạn: hỏi thừa một lần thì server trả lời UNLIMITED
    // ngay, còn đoán sai theo chiều kia là thủng hạn mức.
    this.limited = options.limited !== false;
  }

  get unlimited(): boolean {
    return !this.limited;
  }

  get allowance(): number {
    return this.balance;
  }

  /** Gọi TRƯỚC reader.read(). Trả null khi còn hạn mức — không cấp phát gì cả. */
  request(): Promise<void> | null {
    if (!this.limited) return null;
    if (this.balance > 0) return null;
    if (this.pending) return this.pending;

    this.pending = new Promise<void>((resolve) => {
      this.waiter = resolve;
    });
    this.askFn();
    // ask() có thể trả lời ngay trong cùng lượt (host chạy đồng bộ), khi đó
    // pending đã bị xóa và bên gọi không phải chờ gì.
    return this.pending;
  }

  /** Gọi SAU read() với số byte thật sự nhận được từ mạng. */
  account(bytes: number): void {
    if (!this.limited) return;
    if (!Number.isFinite(bytes) || bytes <= 0) return;
    this.balance -= bytes;
  }

  onGrant(bytes: number): void {
    if (bytes < 0) {
      this.limited = false;
      this.balance = 0;
      this.wake();
      return;
    }

    this.limited = true;
    this.balance += bytes;
    if (this.balance > 0) {
      this.wake();
    } else if (this.waiter) {
      // Lô vừa nhận không đủ trả nợ: hỏi tiếp, đừng ngồi chờ một grant không đến.
      this.askFn();
    }
  }

  /** Hủy piece: đánh thức mọi bên đang chờ để worker không treo. */
  reset(): void {
    this.wake();
  }

  private wake(): void {
    const resolve = this.waiter;
    this.waiter = null;
    this.pending = null;
    resolve?.();
  }
}
