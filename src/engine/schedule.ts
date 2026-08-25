/**
 * Hẹn giờ tải: chỉ cho engine chạy trong những khung giờ người dùng cho phép.
 *
 * Phần tính khung giờ là hàm thuần nhận Date nên test được thẳng trong Node.
 * Phần đặt hẹn nằm trong ScheduleController và chỉ nói chuyện với một AlarmPort
 * tiêm vào — offscreen document của Chromium chỉ chắc chắn có chrome.runtime nên
 * chrome.alarms bắt buộc phải nằm ở background, không phải ở đây.
 *
 * Mọi phép tính đều theo giờ ĐỊA PHƯƠNG: người dùng đặt "chỉ tải ban đêm" là nói
 * về cái đồng hồ trên tường của họ.
 */

export const MINUTES_PER_DAY = 1440;

/** Phút tính từ 0h00 giờ địa phương. */
export type MinuteOfDay = number;

/** 0 = Chủ nhật … 6 = Thứ bảy, khớp với Date.getDay(). */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export const ALL_DAYS: readonly Weekday[] = [0, 1, 2, 3, 4, 5, 6];

export interface ScheduleWindow {
  start: MinuteOfDay;
  end: MinuteOfDay;
  /**
   * Ngày mà khung BẮT ĐẦU. Khung vắt qua nửa đêm vẫn thuộc về ngày bắt đầu, nên
   * "thứ Sáu 23:00–03:00" chạy sang 3 giờ sáng thứ Bảy chứ không mở lúc 2 giờ
   * sáng thứ Sáu.
   */
  days: Weekday[];
}

/* ---------- Đọc và ghi giờ ---------- */

export function minutesOfDay(at: Date): MinuteOfDay {
  return at.getHours() * 60 + at.getMinutes();
}

const CLOCK_TEXT = /^(\d{1,2}):(\d{2})$/;

/** '23:30' -> 1410. Chấp nhận '24:00' để diễn đạt mốc cuối ngày. */
export function parseClock(text: string): MinuteOfDay | null {
  if (typeof text !== 'string') return null;
  const matched = CLOCK_TEXT.exec(text.trim());
  if (!matched) return null;

  const hour = Number(matched[1]);
  const minute = Number(matched[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (hour > 24 || minute > 59) return null;

  const total = hour * 60 + minute;
  return total > MINUTES_PER_DAY ? null : total;
}

export function formatClock(minute: MinuteOfDay): string {
  const clamped = Math.max(0, Math.min(MINUTES_PER_DAY, Math.round(minute)));
  const hour = Math.floor(clamped / 60);
  const rest = clamped % 60;
  return `${String(hour).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

/* ---------- Dựng khung từ dữ liệu không tin được ---------- */

function toMinute(value: unknown): MinuteOfDay | null {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? value : null;
  }
  if (typeof value === 'string') return parseClock(value);
  return null;
}

function toDays(value: unknown): Weekday[] | null {
  // Không ghi ngày nào nghĩa là mọi ngày — đó là lựa chọn mà người dùng hay muốn nhất.
  if (value === undefined || value === null) return [...ALL_DAYS];
  if (!Array.isArray(value)) return null;

  const days = new Set<Weekday>();
  for (const raw of value) {
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > 6) return null;
    days.add(raw as Weekday);
  }
  // Mảng rỗng là khung không bao giờ xảy ra: đó là lỗi cấu hình chứ không phải ý định.
  if (days.size === 0) return null;
  return [...days].sort((a, b) => a - b);
}

/**
 * Dữ liệu trong storage có thể do bản cũ ghi hoặc do người dùng sửa tay, nên mọi
 * khung phải đi qua đây trước khi được tin.
 */
export function normalizeWindow(raw: unknown): ScheduleWindow | null {
  if (!raw || typeof raw !== 'object') return null;
  const src = raw as Record<string, unknown>;

  const start = toMinute(src['start']);
  const end = toMinute(src['end']);
  if (start === null || end === null) return null;
  if (start < 0 || start >= MINUTES_PER_DAY) return null;
  if (end <= 0 || end > MINUTES_PER_DAY) return null;
  // start === end vừa có thể là khung rỗng vừa có thể là trọn 24 giờ; không đoán
  // hộ người dùng, bắt họ ghi 00:00–24:00 nếu muốn cả ngày.
  if (start === end) return null;

  const days = toDays(src['days']);
  if (!days) return null;

  return { start, end, days };
}

export function normalizeWindows(raw: unknown): ScheduleWindow[] {
  if (!Array.isArray(raw)) return [];
  const windows: ScheduleWindow[] = [];
  for (const item of raw) {
    const window = normalizeWindow(item);
    if (window) windows.push(window);
  }
  return windows;
}

/* ---------- Khung giờ ---------- */

export function crossesMidnight(w: ScheduleWindow): boolean {
  return w.end <= w.start;
}

export function windowLength(w: ScheduleWindow): number {
  return crossesMidnight(w) ? MINUTES_PER_DAY - w.start + w.end : w.end - w.start;
}

/**
 * Nửa khoảng [start, end): đúng phút end là đã đóng.
 *
 * Nhờ vậy hai khung liền nhau 08:00–12:00 và 12:00–14:00 không lật trạng thái hai
 * lần tại đúng 12:00.
 */
export function isWithinWindow(w: ScheduleWindow, at: Date): boolean {
  const minute = minutesOfDay(at);
  const today = at.getDay() as Weekday;

  if (w.days.includes(today) && minute >= w.start) {
    if (!crossesMidnight(w)) return minute < w.end;
    return true; // Phần đuôi của hôm nay kéo tới nửa đêm.
  }

  if (crossesMidnight(w)) {
    const yesterday = ((today + 6) % 7) as Weekday;
    if (w.days.includes(yesterday) && minute < w.end) return true;
  }
  return false;
}

/** Không đặt khung nào nghĩa là không hạn chế, chứ không phải cấm tải. */
export function isOpenAt(windows: readonly ScheduleWindow[], at: Date): boolean {
  if (windows.length === 0) return true;
  return windows.some((w) => isWithinWindow(w, at));
}

export interface Boundary {
  at: number;
  open: boolean;
}

/**
 * Mốc gần nhất sau `at` mà kết luận cho/không cho tải bị lật.
 *
 * Cố tình quét mọi mốc bắt đầu/kết thúc trong horizonDays ngày rồi thử lại
 * isOpenAt tại từng mốc, thay vì làm số học trên khoảng: số học vắt qua nửa đêm
 * cộng thêm tập ngày trong tuần là chỗ cực dễ sai một-ly, còn vài chục phép so
 * sánh mỗi lần alarm nổ thì rẻ tới mức không đáng tối ưu. Các khung chồng lấn
 * hoặc liền kề cũng tự gộp mà không cần code gộp riêng.
 */
export function nextBoundary(
  windows: readonly ScheduleWindow[],
  at: Date,
  horizonDays = 8,
): Boundary | null {
  if (windows.length === 0) return null;

  const from = at.getTime();
  const current = isOpenAt(windows, at);
  const candidates = new Set<number>();

  // Bắt đầu từ hôm qua: một khung mở từ tối qua có thể đóng lại trong hôm nay.
  for (let offset = -1; offset <= horizonDays; offset++) {
    const day = new Date(at.getFullYear(), at.getMonth(), at.getDate() + offset);
    const weekday = day.getDay() as Weekday;
    for (const w of windows) {
      if (!w.days.includes(weekday)) continue;
      // Truyền phút vượt quá 1440 cho Date là cách gọn nhất để nó tự dồn sang
      // ngày hôm sau, kể cả khi tháng hay năm đổi.
      const opens = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, w.start);
      const closes = new Date(
        day.getFullYear(),
        day.getMonth(),
        day.getDate(),
        0,
        w.start + windowLength(w),
      );
      candidates.add(opens.getTime());
      candidates.add(closes.getTime());
    }
  }

  const sorted = [...candidates].filter((t) => t > from).sort((a, b) => a - b);
  for (const time of sorted) {
    const open = isOpenAt(windows, new Date(time));
    if (open !== current) return { at: time, open };
  }
  return null;
}

/* ---------- Phần chạm alarm ---------- */

export const SCHEDULE_ALARM = 'df-schedule';
export const HEARTBEAT_ALARM = 'df-schedule-heartbeat';
export const HEARTBEAT_MINUTES = 15;

export interface AlarmPort {
  /** Dùng `when` tuyệt đối: delayInMinutes dưới 1 phút không được tôn trọng. */
  create(name: string, when: number): void;
  createPeriodic(name: string, minutes: number): void;
  clear(name: string): void;
}

export interface ScheduleControllerOptions {
  alarms: AlarmPort;
  /** true = được phép tải. configure() luôn phát một lần; sync() chỉ phát khi đổi. */
  onGate: (open: boolean) => void;
  now?: () => number;
}

/**
 * Giữ kết luận cho/không cho tải và đặt alarm cho mốc lật kế tiếp.
 *
 * Không bao giờ tin vào thời điểm alarm nổ: alarm có thể trễ tùy ý, nên mỗi lần
 * được đánh thức là hỏi lại đồng hồ rồi tính lại từ đầu.
 */
export class ScheduleController {
  private readonly alarms: AlarmPort;
  private readonly onGate: (open: boolean) => void;
  private readonly clock: () => number;
  private windows: ScheduleWindow[] = [];
  private enabledFlag = false;
  private openFlag = true;

  constructor(options: ScheduleControllerOptions) {
    this.alarms = options.alarms;
    this.onGate = options.onGate;
    this.clock = options.now ?? Date.now;
  }

  get open(): boolean {
    return this.openFlag;
  }

  get enabled(): boolean {
    return this.enabledFlag;
  }

  configure(enabled: boolean, windows: readonly ScheduleWindow[]): void {
    this.enabledFlag = enabled === true;
    this.windows = windows.map((w) => ({ ...w, days: [...w.days] }));
    // Phát một lần vô điều kiện: bên nhận vừa đổi cấu hình nên cần biết kết luận
    // hiện tại, kể cả khi nó trùng với kết luận cũ.
    this.evaluate(true);
  }

  /** Gọi khi alarm nổ, khi trình duyệt khởi động, khi cài đặt đổi. */
  sync(): void {
    this.evaluate(false);
  }

  handlesAlarm(name: string): boolean {
    return name === SCHEDULE_ALARM || name === HEARTBEAT_ALARM;
  }

  dispose(): void {
    this.alarms.clear(SCHEDULE_ALARM);
    this.alarms.clear(HEARTBEAT_ALARM);
  }

  private evaluate(announce: boolean): void {
    const at = new Date(this.clock());
    const open = !this.enabledFlag || this.windows.length === 0 ? true : isOpenAt(this.windows, at);
    const changed = open !== this.openFlag;
    this.openFlag = open;
    this.rearm(at);
    if (announce || changed) this.onGate(open);
  }

  private rearm(at: Date): void {
    if (!this.enabledFlag || this.windows.length === 0) {
      this.alarms.clear(SCHEDULE_ALARM);
      this.alarms.clear(HEARTBEAT_ALARM);
      return;
    }

    const boundary = nextBoundary(this.windows, at);
    if (boundary) this.alarms.create(SCHEDULE_ALARM, boundary.at);
    else this.alarms.clear(SCHEDULE_ALARM);

    // Alarm có thể mất khi trình duyệt cập nhật hoặc khởi động lại. Mất lúc cửa
    // đang mở thì hậu quả chỉ là tải quá giờ; mất lúc cửa đang đóng thì người
    // dùng ngồi chờ mãi không thấy tải, nên nhịp tim chỉ chạy ở nhánh đó.
    if (this.openFlag) this.alarms.clear(HEARTBEAT_ALARM);
    else this.alarms.createPeriodic(HEARTBEAT_ALARM, HEARTBEAT_MINUTES);
  }
}
