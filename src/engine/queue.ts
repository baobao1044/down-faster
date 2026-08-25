/**
 * Hàng đợi giới hạn số lượt tải chạy cùng lúc.
 *
 * Hiện tại thêm bao nhiêu job là chạy hết bấy nhiêu; mười file song song không
 * làm mọi thứ nhanh hơn mà chỉ chia nhỏ băng thông rồi bắt cả mười cùng bò.
 *
 * Hàng đợi cố tình không biết gì về DownloadJob: nó chỉ giữ id với trạng thái, và
 * mọi mutator TRẢ VỀ danh sách job cần khởi động thay vì gọi callback. Nhờ vậy
 * test chỉ cần assert trên giá trị trả về, nhưng đổi lại người gọi bắt buộc phải
 * thi hành danh sách đó ở mọi chỗ — bỏ sót một chỗ là job kẹt hàng đợi vĩnh viễn.
 */

export const DEFAULT_MAX_CONCURRENT = 3;

export type Priority = 'high' | 'normal' | 'low';

export const PRIORITY_ORDER: Readonly<Record<Priority, number>> = {
  high: 2,
  normal: 1,
  low: 0,
};

export type QueueEntryState = 'waiting' | 'running' | 'paused';
export type AdmissionAction = 'start' | 'resume';

export interface Admission {
  id: string;
  action: AdmissionAction;
}

export interface QueueEntry {
  id: string;
  priority: Priority;
  state: QueueEntryState;
  /** Đã từng chạy chưa — quyết định gọi job.start() hay job.resume(). */
  started: boolean;
  /**
   * Đang chờ vì cửa lịch đóng, chứ không phải vì chưa tới lượt.
   *
   * Entry như vậy vẫn đang giữ chỗ của một job chạy dở, nên job mới thêm vào
   * không được chen lên trước nó dù ưu tiên cao hơn. Không có cờ này thì đóng
   * cửa lịch vô tình xoá sạch luật "ưu tiên cao không cướp chỗ job đang chạy".
   */
  gated: boolean;
  addedAt: number;
}

/** setOpen trả về cả hai chiều: ai phải dừng, ai được chạy. */
export interface GateChange {
  pause: string[];
  admit: Admission[];
}

export interface QueueOptions {
  maxConcurrent?: number;
  now?: () => number;
}

function sanitizeLimit(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_CONCURRENT;
  return Math.max(1, Math.floor(value));
}

/**
 * Một mảng thứ tự duy nhất, thứ tự mảng chính là thứ tự hiệu lực.
 *
 * Mô hình hai khóa sắp xếp (ưu tiên, rồi thứ tự thêm vào) làm thao tác "chuyển
 * lên đầu hàng" trở nên nói dối: kéo một job ưu tiên thấp lên đầu mà nó vẫn không
 * chạy trước. Với một mảng duy nhất thì cái người dùng nhìn thấy đúng bằng cái
 * sắp xảy ra.
 */
export class DownloadQueue {
  private readonly order: QueueEntry[] = [];
  private readonly clock: () => number;
  private limit: number;
  private gateOpen = true;

  constructor(options: QueueOptions = {}) {
    this.clock = options.now ?? Date.now;
    this.limit = sanitizeLimit(options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT);
  }

  get maxConcurrent(): number {
    return this.limit;
  }

  get open(): boolean {
    return this.gateOpen;
  }

  get runningCount(): number {
    let count = 0;
    for (const entry of this.order) if (entry.state === 'running') count++;
    return count;
  }

  /* ---------- Cấu hình ---------- */

  /** Tăng thì nhận thêm job; giảm thì KHÔNG cắt job đang chạy, chỉ ngừng nhận mới. */
  setMaxConcurrent(n: number): Admission[] {
    this.limit = sanitizeLimit(n);
    return this.pump();
  }

  /**
   * Cửa lịch, tách hẳn khỏi pause của người dùng.
   *
   * Job bị dừng vì hết khung giờ phải tự chạy lại khi tới giờ, nên nó về 'waiting'
   * ngay tại vị trí cũ. Job người dùng tự tay dừng thì tuyệt đối không được tự
   * chạy lại — đó là việc của pause().
   */
  setOpen(open: boolean): GateChange {
    const next = open === true;
    if (next === this.gateOpen) return { pause: [], admit: [] };
    this.gateOpen = next;

    if (!next) {
      const pause: string[] = [];
      for (const entry of this.order) {
        if (entry.state !== 'running') continue;
        entry.state = 'waiting';
        entry.gated = true;
        pause.push(entry.id);
      }
      return { pause, admit: [] };
    }
    return { pause: [], admit: this.pump() };
  }

  /* ---------- Ra vào hàng đợi ---------- */

  enqueue(id: string, priority: Priority = 'normal'): Admission[] {
    if (this.indexOf(id) < 0) {
      this.order.splice(this.insertIndexFor(priority), 0, {
        id,
        priority,
        state: 'waiting',
        started: false,
        gated: false,
        addedAt: this.clock(),
      });
    }
    return this.pump();
  }

  remove(id: string): Admission[] {
    const at = this.indexOf(id);
    if (at >= 0) this.order.splice(at, 1);
    return this.pump();
  }

  complete(id: string): Admission[] {
    return this.remove(id);
  }

  fail(id: string): Admission[] {
    return this.remove(id);
  }

  /** Người dùng tự dừng: nhả chỗ, và không bao giờ tự chạy lại. */
  pause(id: string): Admission[] {
    const entry = this.entry(id);
    if (entry) {
      entry.state = 'paused';
      // Tự tay dừng là tự nhả chỗ: job thôi giữ vị trí của một job đang chạy,
      // kể cả khi trước đó nó bị cửa lịch dừng chứ không phải bị đầy chỗ.
      entry.gated = false;
    }
    return this.pump();
  }

  /**
   * Tiếp tục sau khi người dùng tự dừng.
   *
   * Xếp lại hàng theo đúng luật của enqueue chứ không giữ chỗ cũ: job đã nghỉ thì
   * không có lý do gì chen lên trước những job đã chờ suốt thời gian đó.
   */
  unpause(id: string): Admission[] {
    const at = this.indexOf(id);
    if (at < 0) return this.pump();
    const entry = this.order[at];
    if (!entry || entry.state !== 'paused') return this.pump();

    this.order.splice(at, 1);
    entry.state = 'waiting';
    this.order.splice(this.insertIndexFor(entry.priority), 0, entry);
    return this.pump();
  }

  /* ---------- Sắp xếp ---------- */

  setPriority(id: string, priority: Priority): Admission[] {
    const at = this.indexOf(id);
    if (at < 0) return this.pump();
    const entry = this.order[at];
    if (!entry || entry.priority === priority) return this.pump();

    entry.priority = priority;
    // Job đang chạy giữ nguyên vị trí: đổi ưu tiên không cướp chỗ của ai.
    if (entry.state === 'waiting') {
      this.order.splice(at, 1);
      this.order.splice(this.insertIndexFor(priority), 0, entry);
    }
    return this.pump();
  }

  /**
   * Lên đầu danh sách và được nâng lên 'high'.
   *
   * Chỉ đẩy vị trí thôi là chưa đủ: một job 'high' thêm vào ngay sau đó sẽ chen
   * lên trên và phá mất thao tác vừa rồi của người dùng.
   */
  moveToFront(id: string): Admission[] {
    const at = this.indexOf(id);
    if (at < 0) return this.pump();
    const [entry] = this.order.splice(at, 1);
    if (!entry) return this.pump();

    entry.priority = 'high';
    this.order.unshift(entry);
    return this.pump();
  }

  /**
   * Xếp lại theo danh sách cho trước.
   *
   * Những entry không được nhắc tới đứng yên tại chỗ: chỉ các ô mà entry được
   * nhắc tới đang chiếm mới bị điền lại theo thứ tự mới. Cố tình KHÔNG đụng vào
   * ưu tiên — kéo thả là thao tác về thứ tự, không phải về mức ưu tiên.
   */
  reorder(ids: readonly string[]): Admission[] {
    const wanted: string[] = [];
    const mentioned = new Set<string>();
    for (const id of ids) {
      if (mentioned.has(id) || this.indexOf(id) < 0) continue;
      mentioned.add(id);
      wanted.push(id);
    }
    if (wanted.length === 0) return this.pump();

    const slots: number[] = [];
    const byId = new Map<string, QueueEntry>();
    for (let i = 0; i < this.order.length; i++) {
      const entry = this.order[i];
      if (!entry || !mentioned.has(entry.id)) continue;
      slots.push(i);
      byId.set(entry.id, entry);
    }

    for (let k = 0; k < slots.length && k < wanted.length; k++) {
      const slot = slots[k];
      const id = wanted[k];
      if (slot === undefined || id === undefined) continue;
      const entry = byId.get(id);
      if (entry) this.order[slot] = entry;
    }
    return this.pump();
  }

  /* ---------- Đọc trạng thái ---------- */

  has(id: string): boolean {
    return this.indexOf(id) >= 0;
  }

  get(id: string): QueueEntry | undefined {
    const entry = this.entry(id);
    return entry ? { ...entry } : undefined;
  }

  /** Vị trí trong hàng chờ, 1-based; 0 nếu đang chạy, đang tạm dừng, hoặc không có. */
  positionOf(id: string): number {
    let position = 0;
    for (const entry of this.order) {
      if (entry.state === 'waiting') {
        position++;
        if (entry.id === id) return position;
      } else if (entry.id === id) {
        return 0;
      }
    }
    return 0;
  }

  waiting(): QueueEntry[] {
    return this.order.filter((e) => e.state === 'waiting').map((e) => ({ ...e }));
  }

  running(): QueueEntry[] {
    return this.order.filter((e) => e.state === 'running').map((e) => ({ ...e }));
  }

  snapshot(): QueueEntry[] {
    return this.order.map((e) => ({ ...e }));
  }

  /* ---------- Bên trong ---------- */

  private indexOf(id: string): number {
    return this.order.findIndex((e) => e.id === id);
  }

  private entry(id: string): QueueEntry | undefined {
    return this.order.find((e) => e.id === id);
  }

  /**
   * Chèn sau entry cuối cùng mà job mới không được phép vượt.
   *
   * Chỉ nhảy qua những entry đang chờ có ưu tiên thấp hơn: job đang chạy, job
   * người dùng tạm dừng và job bị cửa lịch dừng đều giữ nguyên chỗ, vì chen lên
   * trước chúng chẳng thay đổi được gì mà chỉ làm danh sách nhảy loạn trước mắt
   * người dùng.
   */
  private insertIndexFor(priority: Priority): number {
    let index = this.order.length;
    while (index > 0) {
      const prev = this.order[index - 1];
      if (!prev) break;
      const jumpable =
        prev.state === 'waiting' &&
        !prev.gated &&
        PRIORITY_ORDER[prev.priority] < PRIORITY_ORDER[priority];
      if (!jumpable) break;
      index--;
    }
    return index;
  }

  /** Nhận job vào chạy cho tới khi đầy chỗ; thứ tự mảng là thứ tự được gọi. */
  private pump(): Admission[] {
    const admissions: Admission[] = [];
    if (!this.gateOpen) return admissions;

    let running = this.runningCount;
    for (const entry of this.order) {
      if (running >= this.limit) break;
      if (entry.state !== 'waiting') continue;
      entry.state = 'running';
      entry.gated = false;
      admissions.push({ id: entry.id, action: entry.started ? 'resume' : 'start' });
      entry.started = true;
      running++;
    }
    return admissions;
  }
}
