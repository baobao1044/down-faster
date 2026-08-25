/**
 * Tự dò số kết nối tối ưu thay vì tin vào một con số cố định.
 *
 * Con số 8 kết nối là phỏng đoán, và phỏng đoán ấy sai theo cả hai chiều: có
 * server chịu được 16 luồng, có server trả 429 ngay ở luồng thứ tư. Module này
 * mượn ý tưởng AIMD của TCP — nhích lên từng bước khi còn nhanh hơn, lùi mạnh
 * khi chạm tường — nhưng thêm hai thứ mà TCP không cần: bộ nhớ về mức đã gây
 * lỗi (`ceiling`) để khỏi đâm lại đúng bức tường đó sau vài chục giây, và khái
 * niệm "cửa sổ không kết luận được" để đừng hiểu nhầm lúc cuối file.
 *
 * Ở đây không có fetch, không có worker, không có đồng hồ thật: mọi thứ vào
 * bằng tham số và ra bằng quyết định, nên test được mà không cần mạng.
 */

export type PressureKind = 'throttled' | 'reset' | 'timeout' | 'refused';

export interface ConcurrencyOptions {
  /** Không bao giờ tụt xuống dưới mức này, kể cả khi server khó tính. */
  min: number;
  /** Trần do người dùng đặt. Bộ dò không bao giờ tự vượt qua nó. */
  max: number;
  /** Khởi đầu khiêm tốn rồi tự leo, an toàn hơn là mở tối đa rồi bị chặn. */
  start: number;
  /** Độ dài một cửa sổ đo. Ngắn quá thì nhiễu, dài quá thì phản ứng chậm. */
  windowMs: number;
  /** Số cửa sổ bỏ qua ngay sau mỗi lần đổi mức, chờ kết nối mới đạt tốc độ. */
  settleWindows: number;
  growStep: number;
  backoffFactor: number;
  /** Phải nhanh hơn bấy nhiêu lần mới coi là "còn tăng được". */
  improveRatio: number;
  /** Tụt dưới mức này sau khi tăng thì coi như tăng hỏng, lùi lại. */
  regressRatio: number;
  /** Ổn định bấy lâu thì thử nhích lên một lần nữa, biết đâu mạng đã rảnh. */
  reprobeAfterMs: number;
  /** Trần do lỗi đặt ra được nới lại từng bước sau bấy lâu. */
  ceilingRelaxMs: number;
  /** Bao nhiêu lần đứt kết nối trong một cửa sổ thì coi là đang bị bóp. */
  resetTolerance: number;
  cooldownMs: number;
  maxCooldownMs: number;
}

export const DEFAULT_CONCURRENCY: ConcurrencyOptions = {
  min: 1,
  max: 8,
  start: 2,
  windowMs: 2000,
  settleWindows: 1,
  growStep: 1,
  backoffFactor: 0.5,
  improveRatio: 1.1,
  regressRatio: 0.92,
  reprobeAfterMs: 30000,
  ceilingRelaxMs: 60000,
  resetTolerance: 2,
  cooldownMs: 5000,
  maxCooldownMs: 120000,
};

export type DecisionKind = 'hold' | 'grow' | 'shrink' | 'wait';

export type DecisionCause =
  | 'warmup'
  | 'settling'
  | 'inconclusive'
  | 'improving'
  | 'saturated'
  | 'regressed'
  | 'throttled'
  | 'unstable'
  | 'cooldown'
  | 'reprobe'
  | 'capped';

export interface ConcurrencyDecision {
  kind: DecisionKind;
  limit: number;
  previous: number;
  cause: DecisionCause;
  /** Câu tiếng Việt cho log và cho ô chẩn đoán trong UI. */
  note: string;
  /** Byte/giây của cửa sổ vừa đóng; null khi chưa đóng cửa sổ nào. */
  throughput: number | null;
}

export interface ConcurrencySnapshot {
  limit: number;
  ceiling: number;
  effectiveMax: number;
  bestThroughput: number;
  bestLimit: number;
  lastThroughput: number;
  cooldownUntil: number;
  windowsClosed: number;
  throttleEvents: number;
}

function clamp(value: number, low: number, high: number): number {
  if (high < low) return low;
  return Math.min(high, Math.max(low, value));
}

export class ConcurrencyController {
  private readonly options: ConcurrencyOptions;

  private currentLimit: number;
  private currentCeiling: number;
  private ceilingSetAt = 0;

  private bestThroughput = 0;
  private bestLimit: number;
  private lastThroughput = 0;

  private cooldownUntil = 0;
  private cooldownStep: number;

  private windowStart: number | null = null;
  private windowBytes = 0;
  /** null nghĩa là chưa ai báo số kết nối đang chạy trong cửa sổ này. */
  private windowMinActive: number | null = null;
  private windowResets = 0;

  private settleRemaining = 0;
  private lastChangeAt = 0;
  /**
   * Mức và tốc độ ngay TRƯỚC lần tăng gần nhất. Có nó mới phân biệt được
   * "tăng xong nhanh hơn" với "tăng xong chậm đi", tức là mới lùi lại đúng chỗ.
   */
  private growFrom: { limit: number; throughput: number } | null = null;

  private windowsClosed = 0;
  private throttleEvents = 0;
  private lastDecision: ConcurrencyDecision;

  constructor(options: Partial<ConcurrencyOptions> = {}) {
    const merged = { ...DEFAULT_CONCURRENCY, ...options };
    const max = Math.max(1, Math.floor(merged.max));
    const min = clamp(Math.floor(merged.min), 1, max);
    this.options = {
      ...merged,
      max,
      min,
      start: clamp(Math.floor(merged.start), min, max),
      growStep: Math.max(1, Math.floor(merged.growStep)),
      settleWindows: Math.max(0, Math.floor(merged.settleWindows)),
      resetTolerance: Math.max(1, Math.floor(merged.resetTolerance)),
      windowMs: Math.max(1, merged.windowMs),
    };

    this.currentLimit = this.options.start;
    this.currentCeiling = this.options.max;
    this.bestLimit = this.options.start;
    this.cooldownStep = this.options.cooldownMs;
    this.lastDecision = {
      kind: 'hold',
      limit: this.currentLimit,
      previous: this.currentLimit,
      cause: 'warmup',
      note: `Bắt đầu với ${this.currentLimit} kết nối rồi tự dò lên`,
      throughput: null,
    };
  }

  get limit(): number {
    return this.currentLimit;
  }

  /**
   * Số slot kết nối được phép dùng ngay lúc này.
   *
   * Trong lúc cooldown trả về 0: server vừa bảo "đừng gõ cửa nữa" thì mở thêm
   * kết nối chỉ tổ ăn thêm 429. Kết nối đang chạy vẫn để yên — cắt ngang là vứt
   * đi số byte đã tải được, mà server có phàn nàn gì về chúng đâu.
   */
  allowedAt(now: number): number {
    if (now < this.cooldownUntil) return 0;
    return this.currentLimit;
  }

  noteBytes(bytes: number, now: number): void {
    if (bytes <= 0) return;
    if (this.windowStart === null) this.resetWindow(now);
    this.windowBytes += bytes;
  }

  /**
   * Số kết nối THỰC SỰ đang chạy.
   *
   * Cái bẫy lớn nhất của mọi bộ điều khiển kiểu này nằm ở đây: cuối file chỉ còn
   * hai piece nên chỉ hai worker chạy, throughput tụt, bộ điều khiển kết luận
   * "bão hòa" rồi giảm mức vĩnh viễn trong khi mạng chẳng có vấn đề gì. Ghi lại
   * mức thấp nhất trong cửa sổ để biết cửa sổ nào không đủ tư cách kết luận.
   */
  noteActive(active: number, now: number): void {
    if (this.windowStart === null) this.resetWindow(now);
    this.windowMinActive =
      this.windowMinActive === null ? active : Math.min(this.windowMinActive, active);
  }

  /**
   * Gọi khi một piece kết thúc, kể cả thành công, để bắt 429/503 và Retry-After.
   *
   * `retryAfterMs` tính bằng MILI-GIÂY, cùng đơn vị với `parseRetryAfterMs()`.
   * Header `Retry-After` ghi bằng giây, nên chỗ nào tự đọc header thì phải nhân
   * 1000 trước khi gọi vào đây; nhầm đơn vị là biến 30 giây chờ thành 8 tiếng.
   */
  noteStatus(status: number, now: number, retryAfterMs?: number | null): void {
    const kind = pressureFromStatus(status);
    if (!kind) return;

    if (kind === 'throttled') {
      const wait =
        retryAfterMs !== undefined && retryAfterMs !== null && retryAfterMs >= 0
          ? retryAfterMs
          : null;
      this.applyPressure(now, 'throttled', `HTTP ${status}: server đang bóp số kết nối`);
      this.enterCooldown(now, wait);
      return;
    }
    this.noteFailure(kind, now);
  }

  noteFailure(kind: PressureKind, now: number): void {
    if (kind === 'throttled') {
      this.applyPressure(now, 'throttled', 'Server báo đang bị quá tải');
      this.enterCooldown(now, null);
      return;
    }

    if (this.windowStart === null) this.resetWindow(now);
    this.windowResets += 1;
    if (this.windowResets < this.options.resetTolerance) return;

    // Một lần đứt kết nối là chuyện thường của mạng. Nhiều lần trong cùng một
    // cửa sổ thì gần như chắc chắn server đang cắt bớt kết nối chứ không phải xui.
    this.applyPressure(
      now,
      'unstable',
      `${this.windowResets} kết nối đứt trong một cửa sổ, coi như đang bị bóp`,
    );
  }

  /** Đóng cửa sổ nếu đã đủ windowMs; luôn trả về quyết định hiện hành. */
  tick(now: number): ConcurrencyDecision {
    this.relaxCeiling(now);

    if (now < this.cooldownUntil) {
      // Đo đạc trong lúc bị cấm cửa là đo tiếng vọng của chính mình.
      this.resetWindow(now);
      return this.record('wait', 'cooldown', this.currentLimit, null, () => {
        const left = Math.ceil((this.cooldownUntil - now) / 1000);
        return `Server yêu cầu chờ, còn ${left} giây nữa mới mở kết nối mới`;
      });
    }

    if (this.windowStart === null) {
      this.resetWindow(now);
      return this.lastDecision;
    }

    const elapsed = now - this.windowStart;
    if (elapsed < this.options.windowMs) return this.lastDecision;

    return this.closeWindow(now, elapsed);
  }

  snapshot(): ConcurrencySnapshot {
    return {
      limit: this.currentLimit,
      ceiling: this.currentCeiling,
      effectiveMax: this.effectiveMax(),
      bestThroughput: this.bestThroughput,
      bestLimit: this.bestLimit,
      lastThroughput: this.lastThroughput,
      cooldownUntil: this.cooldownUntil,
      windowsClosed: this.windowsClosed,
      throttleEvents: this.throttleEvents,
    };
  }

  reset(): void {
    this.currentLimit = this.options.start;
    this.currentCeiling = this.options.max;
    this.ceilingSetAt = 0;
    this.bestThroughput = 0;
    this.bestLimit = this.options.start;
    this.lastThroughput = 0;
    this.cooldownUntil = 0;
    this.cooldownStep = this.options.cooldownMs;
    this.windowStart = null;
    this.windowBytes = 0;
    this.windowMinActive = null;
    this.windowResets = 0;
    this.settleRemaining = 0;
    this.lastChangeAt = 0;
    this.growFrom = null;
    this.windowsClosed = 0;
    this.throttleEvents = 0;
    this.lastDecision = {
      kind: 'hold',
      limit: this.currentLimit,
      previous: this.currentLimit,
      cause: 'warmup',
      note: `Bắt đầu lại với ${this.currentLimit} kết nối`,
      throughput: null,
    };
  }

  /* ---------- Nội bộ ---------- */

  private effectiveMax(): number {
    return Math.min(this.options.max, this.currentCeiling);
  }

  private resetWindow(now: number): void {
    this.windowStart = now;
    this.windowBytes = 0;
    this.windowMinActive = null;
    this.windowResets = 0;
  }

  /**
   * Trần do lỗi đặt ra được nới lại từng bậc một, không trả tự do ngay.
   *
   * Nới thẳng về `max` thì lần sau lại leo đúng lên mức đã bị 429; nới từng bậc
   * biến nó thành "nhớ bài học nhưng không nhớ suốt đời".
   */
  private relaxCeiling(now: number): void {
    if (this.currentCeiling >= this.options.max) return;
    if (now - this.ceilingSetAt < this.options.ceilingRelaxMs) return;
    this.currentCeiling = Math.min(this.options.max, this.currentCeiling + 1);
    this.ceilingSetAt = now;
  }

  private applyLimit(next: number, now: number): boolean {
    const clamped = clamp(Math.floor(next), this.options.min, this.effectiveMax());
    if (clamped === this.currentLimit) return false;
    this.currentLimit = clamped;
    this.lastChangeAt = now;
    this.settleRemaining = this.options.settleWindows;
    this.resetWindow(now);
    return true;
  }

  /**
   * Một đợt bị bóp thường được cả N worker báo về trong vài mili-giây. Phạt đủ N
   * lần sẽ đẩy mức xuống `min` và trần cũng xuống `min`, rồi phải mất N lần
   * `ceilingRelaxMs` mới bò lại được — tức là một cú 429 duy nhất đủ giết tốc độ
   * của cả lượt tải. Đang trong cooldown nghĩa là đợt này đã bị phạt rồi.
   */
  private applyPressure(now: number, cause: DecisionCause, why: string): void {
    if (now < this.cooldownUntil) return;

    this.throttleEvents += 1;
    const before = this.currentLimit;

    // Mức vừa gây lỗi trở thành trần tạm: AIMD thuần sẽ leo lại đúng bức tường
    // đó sau vài chục giây và tạo ra vòng lặp 429 mà có server đáp lại bằng ban IP.
    this.currentCeiling = Math.max(this.options.min, Math.min(this.currentCeiling, before - 1));
    this.ceilingSetAt = now;

    const target = Math.max(this.options.min, Math.floor(before * this.options.backoffFactor));
    this.applyLimit(target, now);
    this.resetWindow(now);
    this.growFrom = null;

    // Kỷ lục đo được ở mức cao hơn không còn là mốc so sánh hợp lệ; giữ lại thì
    // mọi cửa sổ sau đều trông như "không cải thiện" và bộ dò đứng im mãi.
    this.bestThroughput = 0;
    this.bestLimit = this.currentLimit;

    this.record('shrink', cause, before, null, () => `${why}; lùi về ${this.currentLimit} kết nối`);
  }

  private enterCooldown(now: number, retryAfterMs: number | null): void {
    // Retry-After là chỉ thị tường minh của server, luôn thắng con số mặc định
    // và CỐ Ý không bị cắt bớt: gõ cửa sớm hơn lời server dặn là cách nhanh nhất
    // để bị chặn hẳn. Giá trị vô lý thì orchestrator tự quyết bỏ cuộc, nó đọc
    // được cooldownUntil trong snapshot().
    //
    // Nhưng chỉ khi khoảng chờ THẬT SỰ dương. `Retry-After: 0` không mở ra cửa sổ
    // chống trùng nào, nên cả đợt 429 mà tám worker cùng báo sẽ bị applyPressure
    // phạt đủ tám lần: mức tụt thẳng xuống min và trần cũng xuống min, đúng thứ
    // cooldown sinh ra để chặn. Ca đó phải rơi xuống nhịp mặc định bên dưới.
    if (retryAfterMs !== null && retryAfterMs > 0) {
      this.cooldownUntil = Math.max(this.cooldownUntil, now + retryAfterMs);
      return;
    }
    // Vẫn đang trong cooldown thì đây chỉ là worker thứ hai báo lại cùng một đợt.
    // Nhân đôi thêm lần nữa sẽ biến một cú 429 thành hai phút đứng yên.
    if (now < this.cooldownUntil) return;

    const wait = this.cooldownStep;
    this.cooldownStep = Math.min(this.options.maxCooldownMs, this.cooldownStep * 2);
    this.cooldownUntil = Math.max(this.cooldownUntil, now + wait);
  }

  private closeWindow(now: number, elapsed: number): ConcurrencyDecision {
    this.windowsClosed += 1;
    const throughput = elapsed > 0 ? (this.windowBytes * 1000) / elapsed : 0;
    const minActive = this.windowMinActive ?? this.currentLimit;
    this.resetWindow(now);

    if (this.settleRemaining > 0) {
      this.settleRemaining -= 1;
      return this.record(
        'hold',
        'settling',
        this.currentLimit,
        throughput,
        () => 'Cửa sổ ngay sau khi đổi mức, chưa tin được số đo',
      );
    }

    if (minActive < this.currentLimit) {
      // Không đủ kết nối chạy thì cửa sổ này không nói được gì về mức hiện tại.
      return this.record(
        'hold',
        'inconclusive',
        this.currentLimit,
        throughput,
        () => `Chỉ ${minActive}/${this.currentLimit} kết nối có việc, bỏ qua cửa sổ này`,
      );
    }

    if (throughput <= 0) {
      // Cả cửa sổ không nhận được byte nào: server im lặng, mạng đứt, hoặc mọi
      // piece đang chờ ghi. Nhánh "chưa có kỷ lục" bên dưới sẽ hiểu số 0 là một
      // số đo hợp lệ và nhích mức lên sau mỗi cửa sổ, tức là bồi thêm kết nối cho
      // một server đang không trả lời — đúng chiều ngược lại với việc cần làm.
      return this.record(
        'hold',
        'inconclusive',
        this.currentLimit,
        throughput,
        () => 'Không nhận được byte nào trong cửa sổ vừa rồi, chưa kết luận được gì',
      );
    }

    this.lastThroughput = throughput;

    if (this.bestThroughput === 0) {
      this.bestThroughput = throughput;
      this.bestLimit = this.currentLimit;
      return this.growOrHold(now, 'warmup', throughput);
    }

    if (this.growFrom !== null) {
      const base = this.growFrom.throughput;
      const from = this.growFrom.limit;

      if (throughput >= base * this.options.improveRatio) {
        this.bestThroughput = throughput;
        this.bestLimit = this.currentLimit;
        this.cooldownStep = this.options.cooldownMs; // đang khỏe, quên hình phạt cũ đi
        return this.growOrHold(now, 'improving', throughput);
      }

      if (throughput < base * this.options.regressRatio) {
        const before = this.currentLimit;
        this.growFrom = null;
        this.applyLimit(from, now);
        return this.record(
          'shrink',
          'regressed',
          before,
          throughput,
          () => `Thêm kết nối làm chậm đi, lùi về ${this.currentLimit}`,
        );
      }

      this.growFrom = null;
      if (throughput > this.bestThroughput) {
        this.bestThroughput = throughput;
        this.bestLimit = this.currentLimit;
      }
      return this.record(
        'hold',
        'saturated',
        this.currentLimit,
        throughput,
        () => `Thêm kết nối không nhanh hơn, giữ ở ${this.currentLimit}`,
      );
    }

    if (throughput >= this.bestThroughput * this.options.improveRatio) {
      this.bestThroughput = throughput;
      this.bestLimit = this.currentLimit;
      return this.growOrHold(now, 'improving', throughput);
    }

    if (
      now - this.lastChangeAt >= this.options.reprobeAfterMs &&
      this.currentLimit < this.effectiveMax()
    ) {
      return this.growOrHold(now, 'reprobe', throughput);
    }

    if (throughput > this.bestThroughput) {
      this.bestThroughput = throughput;
      this.bestLimit = this.currentLimit;
    }
    return this.record(
      'hold',
      'saturated',
      this.currentLimit,
      throughput,
      () => `Đang ở mức tốt nhất đo được (${this.currentLimit} kết nối)`,
    );
  }

  private growOrHold(
    now: number,
    cause: DecisionCause,
    throughput: number,
  ): ConcurrencyDecision {
    const before = this.currentLimit;
    if (!this.applyLimit(before + this.options.growStep, now)) {
      // Không nâng được thì KHÔNG có phép thử nào đang chờ chấm điểm. Để growFrom
      // của lần nâng trước nằm lại là cửa sổ sau sẽ chấm điểm so với một mốc đã cũ
      // hai cửa sổ, và một dao động bình thường đủ để kéo mức tụt khỏi trần.
      this.growFrom = null;
      return this.record(
        'hold',
        'capped',
        before,
        throughput,
        () => `Đã chạm trần ${this.effectiveMax()} kết nối`,
      );
    }
    this.growFrom = { limit: before, throughput };
    return this.record(
      'grow',
      cause,
      before,
      throughput,
      () => `Thử nâng lên ${this.currentLimit} kết nối`,
    );
  }

  private record(
    kind: DecisionKind,
    cause: DecisionCause,
    previous: number,
    throughput: number | null,
    note: () => string,
  ): ConcurrencyDecision {
    this.lastDecision = {
      kind,
      limit: this.currentLimit,
      previous,
      cause,
      note: note(),
      throughput,
    };
    return this.lastDecision;
  }
}

/**
 * Đọc Retry-After ở cả hai dạng spec cho phép: số giây, hoặc một HTTP-date.
 * Trả về số MILI-GIÂY phải chờ, hoặc null nếu header vô nghĩa.
 *
 * Đơn vị nằm trong tên hàm là cố ý: header ghi bằng giây còn hàm trả mili-giây,
 * và giá trị này đi thẳng vào `noteStatus()`. Lẫn đơn vị một lần là lượt tải
 * đứng im vài tiếng mà không ai hiểu vì sao.
 *
 * `now` PHẢI là đồng hồ tường (`Date.now()`): nhánh HTTP-date so với một mốc
 * tuyệt đối. Đưa vào đồng hồ đơn điệu kiểu `performance.now()` hay một bộ đếm
 * bắt đầu từ 0 sẽ biến một Retry-After hợp lệ thành khoảng chờ nửa thế kỷ.
 */
export function parseRetryAfterMs(value: string | null, now: number): number | null {
  if (!value) return null;
  const raw = value.trim();
  if (raw === '') return null;

  if (/^\d+$/.test(raw)) {
    const seconds = Number(raw);
    return Number.isFinite(seconds) ? seconds * 1000 : null;
  }

  // Date.parse của V8 rộng rãi tới mức nguy hiểm: '1.5' ra ngày 5/1/2001, '-5' ra
  // một ngày năm 2001, '0.5' ra tháng 5 năm 2000. Cả ba đều là Retry-After hỏng,
  // mà nhận bừa thì hoặc ra 0 — mất luôn cooldown mặc định lẫn cơ chế gộp cả đợt
  // 429 thành một lần phạt — hoặc ra vài chục năm chờ. Cả ba dạng HTTP-date mà
  // RFC 9110 cho phép đều mở đầu bằng tên thứ trong tuần, nên đòi đúng chỗ đó là
  // lọc sạch được đám rác mà không loại nhầm dạng hợp lệ nào.
  if (!/^[A-Za-z]{3,9},?\s/.test(raw)) return null;

  // RFC 9110 bắt mọi mốc thời gian HTTP phải tính theo GMT, nhưng dạng asctime
  // ('Wed Oct 21 07:28:30 2015') không mang múi giờ nào và Date.parse hiểu nó là
  // giờ MÁY. Trên một máy ở UTC+7 thì khoảng chờ lệch đúng bảy tiếng — kiểu sai
  // không bao giờ lộ ra ở máy chạy giờ UTC của người viết code.
  const hasZone = /(?:GMT|UTC|Z|[+-]\d{2}:?\d{2})\s*$/i.test(raw);
  const at = Date.parse(hasZone ? raw : `${raw} GMT`);
  if (!Number.isFinite(at)) return null;
  // Mốc thời gian đã trôi qua nghĩa là "thử lại ngay", không phải chờ âm.
  return Math.max(0, at - now);
}

/**
 * Tạm thời moi mã HTTP ra khỏi chuỗi lỗi của fetch worker.
 *
 * Đúng ra FetchEvent 'failed' nên mang sẵn `status`; chừng nào protocol chưa
 * sửa thì đây là cách duy nhất để bộ điều khiển phân biệt 429 với lỗi mạng.
 */
export function statusFromMessage(message: string): number | null {
  const m = /\bHTTP\s+(\d{3})\b/i.exec(message);
  if (!m || !m[1]) return null;
  const status = Number(m[1]);
  return Number.isFinite(status) ? status : null;
}

export function pressureFromStatus(status: number): PressureKind | null {
  if (status === 429 || status === 503 || status === 509) return 'throttled';
  if (status === 408 || status === 504) return 'timeout';
  return null;
}
