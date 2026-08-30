import {
  DownloadJob,
  type CompletedFile,
  type HeaderPort,
  type Job,
  type JobEvents,
  type ThrottlePort,
} from './orchestrator';
import { HlsJob, classifyMediaUrl, probeMedia } from './hls';
import { probe } from './probe';
import type { ProbeResult } from './types';
import {
  classifyGrabUrl,
  dedupUrls,
  GRAB_CONCURRENCY,
  makeFileItem,
  makeMediaItem,
  makeErrorItem,
} from './grab';
import type { HostBridge } from './host';
import type { DownloadTask, Progress, TaskSource } from './types';
import * as storage from './storage';
import { api, runtimeUrl } from '../platform/api';
import type {
  EngineBroadcast,
  EngineRequest,
  EngineResponse,
  GrabbedItem,
  TaskKind,
  TaskSnapshot,
} from '../shared/rpc';
import { DEFAULT_SETTINGS, toDownloadOptions, type Settings } from '../shared/settings';
import { DownloadQueue, type Admission, type Priority } from './queue';
import { ThrottleServer, UNLIMITED } from './throttle';
import { TaskPersistence } from './persistence';
import { planRecovery } from './recovery';
import {
  HeaderStore,
  RuleIdAllocator,
  buildRuleSpec,
  captureFromDownloadItem,
  planReplay,
  synthesizeFromReferrer,
  type ReplayTier,
} from './adaptive/headers';
import { log, warn } from '../shared/log';

/** Số việc song song và tốc độ là hai thứ người dùng đổi giữa chừng nhiều nhất. */
interface Slot {
  job: Job;
  kind: TaskKind;
  priority: Priority;
}

/**
 * Engine host: sở hữu mọi job đang chạy.
 *
 * Chỗ đặt host quan trọng hơn vẻ ngoài của nó. Trang Manager không thể đóng vai
 * này vì người dùng đóng tab là mất hết job. Trên Chromium host nằm trong
 * offscreen document, trên Firefox nằm ngay trong event page.
 */
export class DownloadManager {
  private slots = new Map<string, Slot>();
  private activeConnections = new Map<string, number>();
  /** blobUrl còn sống, chờ trình duyệt lưu xong mới thu hồi. */
  private pendingSave = new Map<string, string>();
  private broadcastTimer: ReturnType<typeof setTimeout> | null = null;

  private settings: Settings;
  private readonly queue: DownloadQueue;
  private readonly throttle: ThrottleServer;
  private readonly persistence: TaskPersistence;
  private readonly headerStore = new HeaderStore();
  private readonly ruleIds = new RuleIdAllocator();

  constructor(
    private readonly bridge: HostBridge,
    settings: Settings = DEFAULT_SETTINGS,
  ) {
    this.settings = settings;
    this.queue = new DownloadQueue({ maxConcurrent: settings.maxConcurrent });
    this.throttle = new ThrottleServer({
      ratePerSecond: settings.speedLimit > 0 ? settings.speedLimit : UNLIMITED,
    });
    this.persistence = new TaskPersistence(
      bridge.store,
      {},
      {
        // `piece.received` đếm byte đã gửi sang writer chứ không phải byte đã nằm
        // trên đĩa. Không ép xả đệm trước khi chốt sổ thì bản ghi hứa nhiều hơn
        // thực tế, và lần khôi phục sau cho ra file hỏng một cách lặng lẽ.
        barrier: (ids) => this.flushWriters(ids),
        onError: (err) => warn('persistence', 'không chốt sổ được', err),
      },
    );
  }

  /* ---------- Cổng dùng chung cho mọi job ---------- */

  private get throttlePort(): ThrottlePort {
    return {
      attach: (id, grant) =>
        this.throttle.attach(id, (g) => grant(g.bytes)),
      detach: (id) => this.throttle.detach(id),
      ask: (id) => this.throttle.request(id),
    };
  }

  private get headerPort(): HeaderPort {
    return {
      has: (url) => this.headerStore.lookup(url) !== null,
      arm: (taskId, url, tier) => this.armRules(taskId, url, tier),
      disarm: (taskId) => this.disarmRules(taskId),
    };
  }

  /**
   * Dựng và cài luật declarativeNetRequest cho một bậc phát lại.
   *
   * Trả về phần header mà `fetch` tự đặt được. Nếu trình duyệt từ chối luật thì
   * phần đi qua mạng coi như không có — thà thiếu Referer còn hơn để job ngồi
   * chờ một luật không bao giờ vào.
   */
  private async armRules(
    taskId: string,
    url: string,
    tier: ReplayTier,
  ): Promise<Record<string, string>> {
    const captured = this.headerStore.lookup(url);
    if (!captured) return {};

    const plan = planReplay(captured, url, tier, this.settings.replayHeaders);
    for (const dropped of plan.dropped) {
      log('headers', `bỏ ${dropped.header}: ${dropped.reason}`);
    }
    if (plan.networkHeaders.length === 0) return plan.fetchHeaders;

    const id = this.ruleIds.take(taskId);
    const spec = buildRuleSpec(id, url, plan);
    if (!spec) {
      this.ruleIds.release(taskId);
      return plan.fetchHeaders;
    }

    const ok = await this.bridge.applyHeaderRules({ add: [spec], removeIds: [id] });
    if (!ok) {
      this.ruleIds.release(taskId);
      warn('headers', 'trình duyệt từ chối luật, chạy tiếp mà không có Referer');
    }
    return plan.fetchHeaders;
  }

  private disarmRules(taskId: string): void {
    const ids = this.ruleIds.all();
    this.ruleIds.release(taskId);
    const remaining = new Set(this.ruleIds.all());
    const gone = ids.filter((id) => !remaining.has(id));
    if (gone.length === 0) return;
    void this.bridge.applyHeaderRules({ add: [], removeIds: gone }).catch(() => {});
  }

  /** Ghi nhớ nguồn dẫn của một link, để phát lại khi server đòi đúng Referer. */
  rememberSource(url: string, pageUrl: string | undefined): void {
    if (!pageUrl) return;
    const capture = captureFromDownloadItem({ url, referrer: pageUrl });
    const synthesized = synthesizeFromReferrer(pageUrl, url, this.settings.replayHeaders);
    capture.referer = synthesized.referer;
    capture.origin = synthesized.origin;
    this.headerStore.remember(url, capture);
  }

  /* ---------- Thêm việc ---------- */

  add(
    url: string,
    filename?: string,
    source: TaskSource = 'manual',
    pageUrl?: string,
    priority: Priority = 'normal',
    mirrors?: string[],
  ): string {
    this.rememberSource(url, pageUrl);

    // Người dùng dán một link playlist vào ô "thêm link" thì họ muốn cái video,
    // không phải file .m3u8 vài KB. Nhận ra sớm tránh giao nhầm hẳn một thứ khác.
    if (classifyMediaUrl(url) !== 'unknown') {
      return this.addMedia(url, filename, pageUrl);
    }

    const job: DownloadJob = new DownloadJob(
      url,
      { ...toDownloadOptions(this.settings), ...(mirrors?.length ? { mirrors } : {}) },
      this.eventsFor(() => job.task),
      source,
      { throttle: this.throttlePort, headers: this.headerPort },
    );
    if (filename) job.task.filename = filename;
    return this.register(job, 'file', priority);
  }

  addMedia(url: string, filename?: string, pageUrl?: string, maxHeight?: number): string {
    this.rememberSource(url, pageUrl);
    const job: HlsJob = new HlsJob(
      url,
      {
        writerWorkerUrl: runtimeUrl('writer-worker.js'),
        concurrency: this.settings.connections,
        maxRetries: this.settings.maxRetries,
        quality: maxHeight && maxHeight > 0 ? { maxHeight } : 'best',
        ...(filename ? { filename } : {}),
      },
      this.eventsFor(() => job.task),
    );
    return this.register(job, 'media', 'normal');
  }

  probeMedia(url: string): ReturnType<typeof probeMedia> {
    return probeMedia(url);
  }

  /* ---------- Link Grabber: dò hàng loạt ---------- */

  /**
   * Dò nhiều URL cùng lúc, trả metadata để người dùng chọn tải cái nào.
   * Concurrency giới hạn 4 để khỏi bắn 64 probe cùng lúc (server sẽ 429).
   */
  async grab(urls: string[]): Promise<GrabbedItem[]> {
    const unique = dedupUrls(urls);
    const results: GrabbedItem[] = [];

    for (let i = 0; i < unique.length; i += GRAB_CONCURRENCY) {
      const batch = unique.slice(i, i + GRAB_CONCURRENCY);
      const settled = await Promise.allSettled(batch.map((url) => this.probeOne(url)));
      for (let j = 0; j < settled.length; j++) {
        const s = settled[j]!;
        results.push(s.status === 'fulfilled' ? s.value : makeErrorItem(batch[j]!, String(s.reason)));
      }
    }
    return results;
  }

  /** Dò một URL: phân loại, gọi probe hoặc probeMedia phù hợp, dựng GrabbedItem. */
  private async probeOne(url: string): Promise<GrabbedItem> {
    const kind = classifyGrabUrl(url);
    if (kind === 'unsupported') return makeErrorItem(url, 'DASH chưa được hỗ trợ');

    if (kind === 'media') {
      const probe = await this.probeMedia(url);
      return makeMediaItem(url, probe);
    }

    // File thường: probe Range.
    const result = await probe(url);
    return makeFileItem(url, result);
  }

  private register(job: Job, kind: TaskKind, priority: Priority): string {
    const id = job.task.id;
    this.slots.set(id, { job, kind, priority });
    this.runAdmissions(this.queue.enqueue(id, priority));
    this.afterStateChange();
    return id;
  }

  /** Job vừa khôi phục đã có sẵn tiến độ; vào hàng như mọi job khác. */
  private adopt(job: Job): void {
    this.slots.set(job.task.id, { job, kind: 'file', priority: 'normal' });
    this.runAdmissions(this.queue.enqueue(job.task.id, 'normal'));
  }

  /* ---------- Hàng đợi ---------- */

  private runAdmissions(admissions: Admission[]): void {
    for (const admission of admissions) {
      const slot = this.slots.get(admission.id);
      if (!slot) continue;
      if (admission.action === 'start') void slot.job.start();
      else slot.job.resume();
    }
    if (admissions.length > 0) this.afterStateChange();
  }

  pause(id: string): void {
    this.slots.get(id)?.job.pause();
    this.runAdmissions(this.queue.pause(id));
    this.afterStateChange();
  }

  resume(id: string): void {
    // Không gọi thẳng job.resume(): hàng đợi mới là bên quyết định đã tới lượt
    // chưa. Bỏ qua nó là cách chắc chắn nhất để trần "3 file cùng lúc" thành lời hứa suông.
    this.runAdmissions(this.queue.unpause(id));
    this.afterStateChange();
  }

  setPriority(id: string, priority: Priority): void {
    const slot = this.slots.get(id);
    if (slot) slot.priority = priority;
    this.runAdmissions(this.queue.setPriority(id, priority));
  }

  moveToFront(id: string): void {
    this.runAdmissions(this.queue.moveToFront(id));
  }

  reorder(ids: string[]): void {
    this.runAdmissions(this.queue.reorder(ids));
  }

  /** Cửa lịch đóng thì dừng hết; mở lại thì đúng những job đó tự chạy tiếp. */
  setGate(open: boolean): void {
    const change = this.queue.setOpen(open);
    for (const id of change.pause) this.slots.get(id)?.job.pause();
    this.runAdmissions(change.admit);
    if (change.pause.length > 0) log('queue', `hết khung giờ, tạm dừng ${change.pause.length} việc`);
  }

  async cancel(id: string): Promise<void> {
    const slot = this.slots.get(id);
    if (!slot) return;
    await slot.job.cancel();
    await this.persistence.forget(id);
    this.forget(id);
  }

  /** Chạy lại một việc đã hỏng, giữ nguyên phần byte đã nằm trên đĩa. */
  retry(id: string): void {
    const slot = this.slots.get(id);
    if (!slot) return;
    if (slot.job.task.state !== 'failed') return;
    for (const piece of slot.job.task.pieces) {
      if (piece.state === 'failed') {
        piece.state = 'pending';
        piece.attempts = 0;
      }
    }
    slot.job.task.error = null;
    this.runAdmissions(this.queue.enqueue(id, slot.priority));
  }

  clearFinished(): void {
    for (const [id, slot] of [...this.slots]) {
      const state = slot.job.task.state;
      if (state === 'completed' || state === 'failed' || state === 'canceled') {
        void this.persistence.forget(id);
        this.forget(id);
      }
    }
  }

  list(): TaskSnapshot[] {
    return [...this.slots.values()]
      .map((slot) => this.snapshot(slot))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  /* ---------- Cài đặt đổi giữa chừng ---------- */

  applySettings(settings: Settings): void {
    this.settings = settings;
    this.throttle.setRate(settings.speedLimit > 0 ? settings.speedLimit : UNLIMITED);
    this.runAdmissions(this.queue.setMaxConcurrent(settings.maxConcurrent));
    log(
      'manager',
      `cài đặt mới: ${settings.maxConcurrent} việc cùng lúc, ` +
        (settings.speedLimit > 0 ? `${Math.round(settings.speedLimit / 1024)} KB/s` : 'không giới hạn tốc độ'),
    );
  }

  /* ---------- Khôi phục sau khi trình duyệt khởi động lại ---------- */

  /**
   * PHẢI chạy trước `storage.cleanupOrphans()`, và `plan.keep` phải được truyền
   * thẳng vào đó. Dọn với tập rỗng sẽ xóa sạch mọi file tạm và biến toàn bộ phần
   * khôi phục thành vô nghĩa mà không phát ra lỗi nào.
   */
  async recover(): Promise<void> {
    let plan;
    try {
      plan = await planRecovery(this.persistence);
    } catch (err) {
      warn('manager', 'không dựng được kế hoạch khôi phục', err);
      return;
    }

    for (const { seed } of plan.resumable) {
      const job: DownloadJob = new DownloadJob(
        seed.url,
        toDownloadOptions(this.settings),
        this.eventsFor(() => job.task),
        seed.source,
        { throttle: this.throttlePort, headers: this.headerPort, resume: seed },
      );
      this.adopt(job);
    }

    for (const item of plan.restartable) {
      log('manager', `${item.record.filename}: tải lại từ đầu — ${item.reason}`);
      this.add(item.record.url, item.record.filename, item.record.source);
    }

    if (plan.resumable.length > 0) {
      log('manager', `khôi phục ${plan.resumable.length} lượt tải dở`);
    }

    if (!plan.partsUnreadable) {
      const removed = await storage.cleanupOrphans(plan.keep);
      if (removed > 0) log('manager', `đã dọn ${removed} file tạm mồ côi`);
    }
    this.afterStateChange();
  }

  /** Ép mọi writer liên quan xả đệm trước khi persistence chốt sổ. */
  private async flushWriters(ids: string[]): Promise<void> {
    await Promise.all(
      ids.map(async (id) => {
        const job = this.slots.get(id)?.job;
        if (job instanceof DownloadJob) await job.flushWriter();
      }),
    );
  }

  /* ---------- Kết thúc một job ---------- */

  /** Trình duyệt đã lưu xong: thu hồi blob URL và dọn file tạm. */
  saved(taskId: string): void {
    const blobUrl = this.pendingSave.get(taskId);
    if (blobUrl) {
      URL.revokeObjectURL(blobUrl);
      this.pendingSave.delete(taskId);
    }
    void storage.removePart(taskId);
    void this.persistence.forget(taskId);
    this.forget(taskId);
    log('manager', `đã dọn file tạm của ${taskId}`);
  }

  private eventsFor(task: () => DownloadTask): JobEvents {
    return {
      onProgress: (p: Progress) => this.onProgress(p),
      onState: () => this.afterStateChange(),
      onComplete: (file: CompletedFile) => void this.onComplete(task().id, file),
      onHandBack: () => void this.onHandBack(task().id),
      onCheckpoint: (t: DownloadTask) => this.persistence.touch(t),
    };
  }

  private async onComplete(taskId: string, file: CompletedFile): Promise<void> {
    this.runAdmissions(this.queue.complete(taskId));
    // Giữ blob URL sống cho tới khi trình duyệt báo đã ghi xong; thu hồi sớm
    // sẽ làm hỏng chính lượt lưu này.
    this.pendingSave.set(taskId, file.blobUrl);
    try {
      await this.bridge.saveFile({ taskId, blobUrl: file.blobUrl, filename: file.filename });
      this.bridge.notify({
        id: taskId,
        title: 'Tải xong',
        message: file.filename,
      });
    } catch (err) {
      warn('manager', 'bàn giao thất bại', err);
      URL.revokeObjectURL(file.blobUrl);
      this.pendingSave.delete(taskId);
      await storage.removePart(taskId);
      this.forget(taskId);
    }
    this.afterStateChange();
  }

  /** Engine bỏ cuộc: đẩy URL gốc về cho trình duyệt tải kiểu thường. */
  private async onHandBack(taskId: string): Promise<void> {
    const slot = this.slots.get(taskId);
    if (!slot) return;
    const { url, filename } = slot.job.task;
    await this.persistence.forget(taskId);
    this.forget(taskId);
    try {
      await this.bridge.handBack({ url, filename });
    } catch (err) {
      warn('manager', 'không trả lại được cho trình duyệt', err);
    }
  }

  private forget(id: string): void {
    this.slots.delete(id);
    this.activeConnections.delete(id);
    this.runAdmissions(this.queue.remove(id));
    this.afterStateChange();
  }

  dispose(): void {
    this.throttle.dispose();
    this.persistence.dispose();
    if (this.broadcastTimer !== null) clearTimeout(this.broadcastTimer);
  }

  /* ---------- Phát trạng thái ---------- */

  private onProgress(p: Progress): void {
    this.activeConnections.set(p.id, p.activeConnections);
    this.afterStateChange();
  }

  private afterStateChange(): void {
    this.bridge.setActiveCount(
      [...this.slots.values()].filter(
        (s) => s.job.task.state === 'downloading' || s.job.task.state === 'probing',
      ).length,
    );
    this.scheduleBroadcast();
  }

  /** Gom nhiều cập nhật vào một lần phát để không ngập kênh message. */
  private scheduleBroadcast(): void {
    if (this.broadcastTimer !== null) return;
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      const message: EngineBroadcast = { type: 'engine:update', tasks: this.list() };
      // Không có UI nào mở thì sendMessage báo lỗi; đó là chuyện bình thường.
      void api.runtime.sendMessage(message).catch(() => {});
    }, 400);
  }

  private snapshot(slot: Slot): TaskSnapshot {
    const task = slot.job.task;
    const entry = this.queue.get(task.id);
    const remaining = task.size === null ? null : Math.max(0, task.size - task.received);
    return {
      id: task.id,
      url: task.url,
      filename: task.filename,
      size: task.size,
      received: task.received,
      state: task.state,
      speed: task.speed,
      error: task.error,
      connections: this.activeConnections.get(task.id) ?? 0,
      createdAt: task.createdAt,
      kind: slot.kind,
      source: task.source,
      priority: slot.priority,
      position: this.queue.positionOf(task.id),
      queueState: entry?.state ?? 'none',
      eta: remaining !== null && task.speed > 0 ? Math.round(remaining / task.speed) : null,
    };
  }
}

/**
 * Thi hành một lệnh của engine. Trả về true nếu lời đáp tới sau (bên gọi phải
 * giữ kênh message mở).
 *
 * Tách khỏi listener vì trên Firefox engine sống ngay trong background, mà
 * `runtime.sendMessage` KHÔNG gửi được cho chính ngữ cảnh đã gửi. Không có lối
 * gọi thẳng này thì mọi lệnh background phát cho engine — menu chuột phải, lượt
 * tải tự giành được, cài đặt vừa đổi — đều rơi vào hư không mà không báo lỗi gì.
 */
export function dispatchEngineRequest(
  manager: DownloadManager,
  req: EngineRequest,
  respond: (response: EngineResponse) => void,
): boolean {
  switch (req.type) {
    case 'engine:ping':
      respond({ ok: true });
      return false;
    case 'engine:add':
      respond({
        ok: true,
        id: manager.add(
          req.url,
          req.filename,
          req.source,
          req.pageUrl,
          req.priority,
          req.mirrors,
        ),
      });
      return false;
    case 'engine:add-media':
      respond({ ok: true, id: manager.addMedia(req.url, req.filename, req.pageUrl, req.maxHeight) });
      return false;
    case 'engine:probe-media':
      void manager
        .probeMedia(req.url)
        .then((probe) => respond({ ok: true, probe }))
        .catch((err: unknown) => respond({ ok: false, error: String(err) }));
      return true;
    case 'engine:pause':
      manager.pause(req.id);
      respond({ ok: true });
      return false;
    case 'engine:resume':
      manager.resume(req.id);
      respond({ ok: true });
      return false;
    case 'engine:retry':
      manager.retry(req.id);
      respond({ ok: true });
      return false;
    case 'engine:cancel':
      void manager.cancel(req.id).then(() => respond({ ok: true }));
      return true; // Giữ kênh mở cho lời đáp bất đồng bộ.
    case 'engine:saved':
      manager.saved(req.id);
      respond({ ok: true });
      return false;
    case 'engine:priority':
      manager.setPriority(req.id, req.priority);
      respond({ ok: true });
      return false;
    case 'engine:front':
      manager.moveToFront(req.id);
      respond({ ok: true });
      return false;
    case 'engine:reorder':
      manager.reorder(req.ids);
      respond({ ok: true });
      return false;
    case 'engine:clear-finished':
      manager.clearFinished();
      respond({ ok: true });
      return false;
    case 'engine:settings':
      manager.applySettings(req.settings);
      respond({ ok: true });
      return false;
    case 'engine:gate':
      manager.setGate(req.open);
      respond({ ok: true });
      return false;
    case 'engine:list':
      respond({ ok: true, tasks: manager.list() });
      return false;
    case 'engine:grab':
      void manager
        .grab(req.urls)
        .then((grab) => respond({ ok: true, grab }))
        .catch((err: unknown) => respond({ ok: false, error: String(err) }));
      return true; // Async: giữ kênh mở cho lời đáp.
    default:
      return false;
  }
}

/** Gắn engine host vào ngữ cảnh hiện tại và bắt đầu nhận lệnh. */
export function installEngineHost(
  bridge: HostBridge,
  settings: Settings = DEFAULT_SETTINGS,
): DownloadManager {
  const manager = new DownloadManager(bridge, settings);

  api.runtime.onMessage.addListener(
    (message: unknown, _sender, sendResponse: (r: EngineResponse) => void) => {
      const req = message as EngineRequest;
      if (typeof req?.type !== 'string' || !req.type.startsWith('engine:')) return false;
      return dispatchEngineRequest(manager, req, sendResponse);
    },
  );

  // Khôi phục việc dở của phiên trước, rồi mới dọn file tạm mồ côi. Thứ tự này
  // bắt buộc: dọn trước là xóa mất đúng thứ sắp được dùng lại.
  void manager.recover();

  log('manager', 'engine host sẵn sàng');
  return manager;
}
