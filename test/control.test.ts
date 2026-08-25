import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TokenBucket,
  ThrottleClient,
  ThrottleServer,
  connectionsForRate,
  grantSize,
  type TimerPort,
} from '../src/engine/throttle';
import { DownloadQueue, type Admission } from '../src/engine/queue';
import {
  ALL_DAYS,
  MINUTES_PER_DAY,
  SCHEDULE_ALARM,
  HEARTBEAT_ALARM,
  HEARTBEAT_MINUTES,
  ScheduleController,
  crossesMidnight,
  formatClock,
  isOpenAt,
  nextBoundary,
  normalizeWindow,
  normalizeWindows,
  parseClock,
  windowLength,
  type AlarmPort,
  type ScheduleWindow,
} from '../src/engine/schedule';

/* ================= Đồng hồ và timer giả ================= */

/** Thời gian mô phỏng: không có setTimeout thật nào chạy trong test này. */
class FakeTime {
  private t = 0;
  private seq = 0;
  /** Đếm tổng số lần hẹn giờ: một hàng chờ kẹt lộ ra ở đây trước khi lộ ở đâu khác. */
  private armed = 0;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();

  now = (): number => this.t;

  readonly port: TimerPort = {
    set: (fn, ms) => {
      const id = ++this.seq;
      this.armed++;
      this.timers.set(id, { at: this.t + Math.max(1, ms), fn });
      return id;
    },
    clear: (handle) => {
      this.timers.delete(handle);
    },
  };

  get pending(): number {
    return this.timers.size;
  }

  get armedCount(): number {
    return this.armed;
  }

  advance(ms: number): void {
    const target = this.t + ms;
    for (;;) {
      let nextId = -1;
      let nextAt = Number.POSITIVE_INFINITY;
      for (const [id, timer] of this.timers) {
        if (timer.at < nextAt) {
          nextAt = timer.at;
          nextId = id;
        }
      }
      if (nextId < 0 || nextAt > target) break;
      const timer = this.timers.get(nextId);
      this.timers.delete(nextId);
      this.t = nextAt;
      timer?.fn();
    }
    this.t = target;
  }
}

/* ================= Xô token ================= */

test('xô đầy sẵn lúc khởi tạo nên file nhỏ không bị phạt oan', () => {
  const time = new FakeTime();
  const bucket = new TokenBucket({ ratePerSecond: 1000, now: time.now });
  assert.equal(bucket.available(), 1000);
  assert.equal(bucket.take(1000), 1000);
});

test('nạp đúng theo thời gian trôi: 500ms ở 1000 KB/s cho 512000 byte', () => {
  const time = new FakeTime();
  const rate = 1024 * 1000;
  const bucket = new TokenBucket({ ratePerSecond: rate, now: time.now });
  bucket.take(rate); // Vét sạch xô khởi tạo để chỉ còn đo phần nạp thêm.
  time.advance(500);
  assert.equal(bucket.available(), 512000);
});

test('đứng yên lâu vẫn không tích quá trần một giây, để timer trễ không thành cú xả ồ ạt', () => {
  const time = new FakeTime();
  const rate = 1024 * 1024;
  const bucket = new TokenBucket({ ratePerSecond: rate, now: time.now });
  bucket.take(rate);
  time.advance(10_000);
  assert.equal(bucket.available(), rate);
});

test('waitFor tính đúng số mili-giây còn thiếu', () => {
  const time = new FakeTime();
  const bucket = new TokenBucket({ ratePerSecond: 1000, now: time.now });
  bucket.take(1000);
  assert.equal(bucket.waitFor(500), 500);
  time.advance(250);
  assert.equal(bucket.waitFor(500), 250);
  assert.equal(bucket.waitFor(200), 0);
});

test('xin quá trần thì waitFor quy về đúng trần chứ không trả một con số không bao giờ tới', () => {
  const time = new FakeTime();
  const bucket = new TokenBucket({ ratePerSecond: 1000, now: time.now });
  bucket.take(1000);
  // Trần là 1000 byte, xin 5000 mà chờ 5 giây thì vẫn chỉ có 1000.
  assert.equal(bucket.waitFor(5000), 1000);
});

test('take lấy được phần lẻ khi không đủ, thay vì trả 0 và bỏ đói', () => {
  const time = new FakeTime();
  const bucket = new TokenBucket({ ratePerSecond: 1000, now: time.now });
  bucket.take(1000);
  time.advance(250);
  assert.equal(bucket.take(1000), 250);
});

test('rate <= 0 là không giới hạn: take trả đúng số xin, waitFor luôn 0', () => {
  const bucket = new TokenBucket({ ratePerSecond: 0 });
  assert.equal(bucket.unlimited, true);
  assert.equal(bucket.take(12_345_678), 12_345_678);
  assert.equal(bucket.waitFor(12_345_678), 0);
  assert.equal(bucket.available(), Number.POSITIVE_INFINITY);
});

/* ================= Server và client hạn mức ================= */

/** Dựng một đám worker tham lam: nhận lô nào là tiêu ngay và xin lô kế tiếp. */
function greedy(rate: number, ids: readonly string[], time: FakeTime) {
  const server = new ThrottleServer({ ratePerSecond: rate, now: time.now, timer: time.port });
  const got = new Map<string, number>();
  for (const id of ids) {
    got.set(id, 0);
    server.attach(id, (grant) => {
      got.set(id, (got.get(id) ?? 0) + grant.bytes);
      server.request(id);
    });
  }
  for (const id of ids) server.request(id);
  const total = () => [...got.values()].reduce((sum, n) => sum + n, 0);
  return { server, got, total };
}

test('tổng byte cấp trong một giây mô phỏng bám sát hạn mức, sai số dưới một lô', () => {
  const time = new FakeTime();
  const rate = 1024 * 1024;
  const { total } = greedy(rate, ['a', 'b'], time);

  // Giây đầu tiêu luôn cả xô đầy sẵn nên không đại diện; đo giây thứ hai.
  time.advance(1000);
  const mark = total();
  time.advance(1000);
  const second = total() - mark;

  const batch = grantSize(rate, 2);
  assert.ok(
    second <= rate + batch && second >= rate - batch,
    `giây thứ hai cấp ${second} byte, ngoài khoảng ${rate} +/- ${batch}`,
  );
});

test('hai worker cùng chờ thì được cấp luân phiên, chênh nhau không quá một lô', () => {
  const time = new FakeTime();
  const rate = 1024 * 1024;
  const { got } = greedy(rate, ['a', 'b'], time);

  // Bỏ qua giây đầu: xô đầy sẵn dồn hết cho worker hỏi trước, mà lúc đó worker
  // kia còn chưa xếp hàng nên chưa có gì để chia cho công bằng cả. Luân phiên chỉ
  // là lời hứa với những worker CÙNG đang chờ.
  time.advance(1000);
  const markA = got.get('a') ?? 0;
  const markB = got.get('b') ?? 0;

  time.advance(2000);
  const a = (got.get('a') ?? 0) - markA;
  const b = (got.get('b') ?? 0) - markB;
  assert.ok(a > 0 && b > 0, 'cả hai worker đều phải được cấp');
  assert.ok(
    Math.abs(a - b) <= grantSize(rate, 2),
    `chênh lệch ${Math.abs(a - b)} byte vượt quá một lô`,
  );
});

test('client đã detach thì không nhận grant nữa', () => {
  const time = new FakeTime();
  const { server, got } = greedy(1024 * 1024, ['a', 'b'], time);
  time.advance(1000);

  server.detach('a');
  const frozen = got.get('a') ?? 0;
  const mark = got.get('b') ?? 0;

  time.advance(1000);
  assert.equal(got.get('a'), frozen, 'worker đã chết không được cấp thêm byte nào');
  assert.ok((got.get('b') ?? 0) - mark > 0, 'worker còn lại phải nhận tiếp hạn mức');
});

test('không giới hạn thì server không đặt timer nào và client không hỏi lần nào', () => {
  const time = new FakeTime();
  const server = new ThrottleServer({ ratePerSecond: 0, now: time.now, timer: time.port });
  let asks = 0;
  const client = new ThrottleClient({
    ask: () => {
      asks++;
      server.request('w');
    },
    limited: false,
  });
  server.attach('w', (grant) => client.onGrant(grant.bytes));

  assert.equal(client.request(), null);
  client.account(64 * 1024);
  assert.equal(client.request(), null);
  assert.equal(asks, 0);
  assert.equal(time.pending, 0);
});

/** Nối một ThrottleClient thẳng vào server, đúng như orchestrator sẽ làm. */
function wire(server: ThrottleServer, id: string) {
  let asks = 0;
  const client = new ThrottleClient({
    ask: () => {
      asks++;
      server.request(id);
    },
    limited: !server.unlimited,
  });
  server.attach(id, (grant) => client.onGrant(grant.bytes));
  return { client, asks: () => asks };
}

test('setRate bật giới hạn giữa chừng thì mọi client đang chạy bị kéo về chế độ hỏi xin', () => {
  const time = new FakeTime();
  const server = new ThrottleServer({ ratePerSecond: 0, now: time.now, timer: time.port });
  const a = wire(server, 'a');
  const b = wire(server, 'b');
  assert.equal(a.client.unlimited, true);
  assert.equal(b.client.unlimited, true);

  server.setRate(1024 * 1024);
  assert.equal(a.client.unlimited, false);
  assert.equal(b.client.unlimited, false);

  // Xô còn đầy nên lô đầu được cấp ngay trong cùng lượt, không phải chờ.
  assert.equal(a.client.request(), null);
  assert.ok(a.client.allowance > 0);
});

test('setRate bỏ giới hạn giữa chừng thì client nhận grant âm và thôi hỏi', () => {
  const time = new FakeTime();
  const server = new ThrottleServer({ ratePerSecond: 1024 * 1024, now: time.now, timer: time.port });
  const a = wire(server, 'a');
  a.client.request();
  assert.equal(a.client.unlimited, false);

  server.setRate(0);
  assert.equal(a.client.unlimited, true);

  const before = a.asks();
  a.client.account(100 * 1024 * 1024);
  assert.equal(a.client.request(), null);
  assert.equal(a.asks(), before);
});

test('request() trả null khi còn hạn mức, trả Promise khi hết', async () => {
  let asks = 0;
  const client = new ThrottleClient({ ask: () => asks++ });

  const wait = client.request();
  assert.ok(wait instanceof Promise);
  assert.equal(asks, 1);
  // Hỏi lại lúc đang chờ thì dùng chung một lời hứa, không sinh thêm message.
  assert.equal(client.request(), wait);
  assert.equal(asks, 1);

  client.onGrant(64 * 1024);
  await wait;
  assert.equal(client.request(), null);
});

test('account cho nợ âm và lô kế tiếp bị trừ đúng phần nợ', () => {
  const client = new ThrottleClient({ ask: () => {} });
  client.onGrant(1000);
  client.account(1500);
  assert.equal(client.allowance, -500);

  client.onGrant(1000);
  assert.equal(client.allowance, 500);
});

test('reset() giải phóng bên đang chờ để hủy piece không làm worker treo', async () => {
  const client = new ThrottleClient({ ask: () => {} });
  const wait = client.request();
  assert.ok(wait instanceof Promise);

  let resolved = false;
  void wait.then(() => {
    resolved = true;
  });
  client.reset();
  await wait;
  assert.equal(resolved, true);
});

test('dispose() nhả mọi worker đang chờ thay vì bỏ chúng treo vĩnh viễn', async () => {
  const time = new FakeTime();
  const server = new ThrottleServer({ ratePerSecond: 1024, now: time.now, timer: time.port });
  const w = wire(server, 'w');
  // Vét sạch xô rồi xin tiếp: lúc này client chắc chắn đang chờ.
  w.client.request();
  w.client.account(4096);
  const wait = w.client.request();
  assert.ok(wait instanceof Promise, 'client phải đang chờ thì test mới có ý nghĩa');

  // Không await thẳng: nếu dispose bỏ quên bên chờ thì test phải đỏ, chứ không
  // được treo cùng với nó.
  let released = false;
  void wait.then(() => {
    released = true;
  });
  server.dispose();
  await Promise.resolve();

  assert.equal(released, true, 'dispose phải nhả bên đang chờ, nếu không worker treo vĩnh viễn');
  assert.equal(w.client.unlimited, true);
  assert.equal(time.pending, 0, 'dispose phải dọn sạch timer');
});

test('connectionsForRate hạ số kết nối khi hạn mức quá thấp, và không đổi khi không giới hạn', () => {
  assert.equal(connectionsForRate(0, 8), 8);
  assert.equal(connectionsForRate(200 * 1024, 8), 1);
  assert.equal(connectionsForRate(1024 * 1024, 8), 4);
  assert.equal(connectionsForRate(100 * 1024 * 1024, 8), 8);
});

test('connectionsForRate không bao giờ trả NaN dù số kết nối yêu cầu là rác', () => {
  // Math.max(1, NaN) vẫn ra NaN, và vòng lặp spawn với NaN kết nối chạy không
  // vòng nào: lượt tải đứng im mà không có lỗi nào để lần theo.
  assert.equal(connectionsForRate(1024 * 1024, Number.NaN), 1);
  assert.equal(connectionsForRate(0, Number.NaN), 1);
  assert.equal(connectionsForRate(1024 * 1024, 0), 1);
});

test('hạn mức nhỏ hơn một byte mỗi giây vẫn cấp được, không quay timer vô ích', () => {
  const time = new FakeTime();
  const server = new ThrottleServer({ ratePerSecond: 0.5, now: time.now, timer: time.port });
  let got = 0;
  server.attach('a', (grant) => {
    got += grant.bytes;
    server.request('a');
  });
  server.request('a');
  time.advance(10_000);

  // take() làm tròn xuống, nên xô chỉ chứa nổi nửa byte là xô không bao giờ phát
  // ra nổi byte nào — mà bên chờ thì cứ một mili-giây lại bị đánh thức một lần.
  assert.ok(got > 0, 'hạn mức dưới một byte làm hàng chờ kẹt vĩnh viễn');
  assert.ok(time.armedCount < 50, `đặt ${time.armedCount} timer trong 10 giây, đang quay vòng vô ích`);
});

test('vòng đọc thật (xin → đọc → trừ nợ) không vượt hạn mức và không treo', async () => {
  const time = new FakeTime();
  const rate = 512 * 1024;
  const chunk = 64 * 1024;
  const server = new ThrottleServer({ ratePerSecond: rate, now: time.now, timer: time.port });
  const client = new ThrottleClient({ ask: () => server.request('w'), limited: true });
  server.attach('w', (grant) => client.onGrant(grant.bytes));

  let read = 0;
  let done = false;
  // Đúng thứ tự mà fetch-worker bắt buộc phải theo: xin hạn mức, đọc, rồi trừ
  // đúng số byte đã thật sự đi qua mạng.
  const loop = (async () => {
    for (let i = 0; i < 40; i++) {
      const wait = client.request();
      if (wait) await wait;
      read += chunk;
      client.account(chunk);
    }
    done = true;
  })();

  for (let step = 0; step < 500 && !done; step++) {
    await Promise.resolve();
    if (!done) time.advance(50);
  }
  await loop;

  assert.equal(done, true, 'vòng đọc phải chạy hết chứ không kẹt ở một grant không bao giờ tới');
  // Trần lý thuyết: một xô đầy sẵn, cộng phần nạp theo thời gian, cộng đúng một
  // chunk nợ vì không thể biết trước chunk dài bao nhiêu byte.
  const budget = rate + (rate * time.now()) / 1000 + chunk;
  assert.ok(read <= budget, `đọc ${read} byte trong ${time.now()}ms, vượt trần ${budget}`);
});

/* ================= Hàng đợi ================= */

const ids = (list: Admission[]): string[] => list.map((a) => a.id);

/** Hàng đợi mặc định với năm job: a, b, c chạy; d, e chờ. */
function filled(max = 3): { queue: DownloadQueue; admitted: string[] } {
  const queue = new DownloadQueue({ maxConcurrent: max, now: () => 0 });
  const admitted: string[] = [];
  for (const id of ['a', 'b', 'c', 'd', 'e']) admitted.push(...ids(queue.enqueue(id)));
  return { queue, admitted };
}

test('thêm 5 job thì chỉ 3 chạy, đúng giới hạn mặc định', () => {
  const { queue, admitted } = filled();
  assert.deepEqual(admitted, ['a', 'b', 'c']);
  assert.equal(queue.runningCount, 3);
  assert.deepEqual(
    queue.waiting().map((e) => e.id),
    ['d', 'e'],
  );
});

test('job xong thì job kế tiếp trong hàng được nhận vào', () => {
  const { queue } = filled();
  assert.deepEqual(queue.complete('a'), [{ id: 'd', action: 'start' }]);
  assert.equal(queue.has('a'), false);
  assert.equal(queue.runningCount, 3);
});

test('ưu tiên cao chen lên đầu hàng chờ nhưng không cướp chỗ job đang chạy', () => {
  const { queue } = filled();
  assert.deepEqual(queue.enqueue('vip', 'high'), []);
  assert.equal(queue.runningCount, 3);
  assert.equal(queue.positionOf('vip'), 1);
  assert.deepEqual(ids(queue.complete('a')), ['vip']);
});

test('moveToFront giữ được vị trí đầu kể cả khi sau đó thêm một job ưu tiên cao', () => {
  const { queue } = filled();
  queue.moveToFront('e');
  assert.equal(queue.positionOf('e'), 1);

  queue.enqueue('vip', 'high');
  assert.equal(queue.positionOf('e'), 1);
  assert.equal(queue.positionOf('vip'), 2);
});

test('reorder giữ nguyên thứ tự tương đối của những entry không được nhắc tới', () => {
  const queue = new DownloadQueue({ maxConcurrent: 1 });
  for (const id of ['a', 'b', 'c', 'd']) queue.enqueue(id);

  queue.reorder(['d', 'b']);
  assert.deepEqual(
    queue.snapshot().map((e) => e.id),
    ['a', 'd', 'c', 'b'],
  );
});

test('reorder không đổi ưu tiên của ai cả', () => {
  const queue = new DownloadQueue({ maxConcurrent: 1 });
  queue.enqueue('a', 'high');
  queue.enqueue('b', 'low');
  queue.enqueue('c');

  queue.reorder(['c', 'b', 'a']);
  assert.equal(queue.get('a')?.priority, 'high');
  assert.equal(queue.get('b')?.priority, 'low');
  assert.equal(queue.get('c')?.priority, 'normal');
});

test('người dùng tạm dừng job đang chạy thì nhả chỗ cho job kế tiếp', () => {
  const { queue } = filled();
  assert.deepEqual(queue.pause('a'), [{ id: 'd', action: 'start' }]);
  assert.equal(queue.get('a')?.state, 'paused');
});

test('job người dùng tự dừng không bao giờ tự chạy lại, kể cả khi có chỗ trống', () => {
  const { queue } = filled();
  queue.pause('a');
  queue.complete('b');
  queue.complete('c');
  queue.complete('d');
  assert.deepEqual(ids(queue.complete('e')), []);
  assert.equal(queue.get('a')?.state, 'paused');
  assert.equal(queue.runningCount, 0);
});

test('unpause thì phải xếp hàng lại chứ không chen ngang', () => {
  const { queue } = filled();
  queue.pause('a'); // d được nhận vào thay chỗ

  assert.deepEqual(queue.unpause('a'), []);
  assert.equal(queue.get('a')?.state, 'waiting');
  assert.equal(queue.positionOf('e'), 1);
  assert.equal(queue.positionOf('a'), 2);
});

test('hủy job đang chạy nhả chỗ, hủy job đang chờ thì không ảnh hưởng ai', () => {
  const { queue } = filled();
  assert.deepEqual(ids(queue.remove('a')), ['d']);
  assert.deepEqual(ids(queue.remove('e')), []);
  assert.equal(queue.has('e'), false);
});

test('tăng maxConcurrent nhận thêm job ngay; giảm thì không cắt job đang chạy', () => {
  const { queue } = filled();
  assert.deepEqual(ids(queue.setMaxConcurrent(5)), ['d', 'e']);
  assert.equal(queue.runningCount, 5);

  assert.deepEqual(queue.setMaxConcurrent(1), []);
  assert.equal(queue.runningCount, 5);
});

test('đóng cửa lịch trả về danh sách phải dừng và không nhận thêm ai', () => {
  const { queue } = filled();
  const gate = queue.setOpen(false);
  assert.deepEqual(gate.pause, ['a', 'b', 'c']);
  assert.deepEqual(gate.admit, []);
  assert.equal(queue.runningCount, 0);
  assert.deepEqual(queue.complete('d'), []);
});

test('mở lại cửa thì job từng chạy được resume chứ không start lại từ đầu', () => {
  const { queue } = filled();
  queue.setOpen(false);
  const back = queue.setOpen(true);
  assert.deepEqual(back.pause, []);
  assert.deepEqual(back.admit, [
    { id: 'a', action: 'resume' },
    { id: 'b', action: 'resume' },
    { id: 'c', action: 'resume' },
  ]);
});

test('job bị lịch dừng giữ nguyên vị trí, không bị đẩy xuống cuối hàng', () => {
  const { queue } = filled();
  queue.setOpen(false);
  assert.deepEqual(
    queue.snapshot().map((e) => e.id),
    ['a', 'b', 'c', 'd', 'e'],
  );
  assert.equal(queue.positionOf('a'), 1);
});

test('cửa lịch đóng không xoá quyền giữ chỗ: job mới ưu tiên cao vẫn xếp sau job tải dở', () => {
  const queue = new DownloadQueue({ maxConcurrent: 2, now: () => 0 });
  for (const id of ['a', 'b', 'c']) queue.enqueue(id);
  queue.setOpen(false);

  queue.enqueue('vip', 'high');
  // a và b đang tải dở, chỉ tạm nghỉ vì hết khung giờ; c thì chưa từng chạy.
  assert.deepEqual(
    queue.snapshot().map((e) => e.id),
    ['a', 'b', 'vip', 'c'],
  );

  assert.deepEqual(queue.setOpen(true).admit, [
    { id: 'a', action: 'resume' },
    { id: 'b', action: 'resume' },
  ]);
});

test('job bị lịch dừng rồi được người dùng tự dừng thì thôi giữ chỗ', () => {
  const queue = new DownloadQueue({ maxConcurrent: 1, now: () => 0 });
  queue.enqueue('a');
  queue.setOpen(false);
  queue.pause('a');
  queue.setOpen(true);

  assert.equal(queue.get('a')?.gated, false);
  assert.deepEqual(ids(queue.enqueue('b')), ['b']);
  assert.equal(queue.get('a')?.state, 'paused');
});

test('setPriority xếp lại job đang chờ nhưng không làm job đang chạy nhảy chỗ', () => {
  const queue = new DownloadQueue({ maxConcurrent: 1, now: () => 0 });
  for (const id of ['a', 'b', 'c', 'd']) queue.enqueue(id);

  queue.setPriority('d', 'high');
  assert.deepEqual(
    queue.snapshot().map((e) => e.id),
    ['a', 'd', 'b', 'c'],
  );

  queue.setPriority('b', 'low');
  assert.deepEqual(
    queue.snapshot().map((e) => e.id),
    ['a', 'd', 'c', 'b'],
  );

  assert.deepEqual(queue.setPriority('a', 'low'), []);
  assert.deepEqual(
    queue.snapshot().map((e) => e.id),
    ['a', 'd', 'c', 'b'],
  );
});

test('positionOf đếm đúng và trả 0 cho job đang chạy', () => {
  const { queue } = filled();
  assert.equal(queue.positionOf('a'), 0);
  assert.equal(queue.positionOf('d'), 1);
  assert.equal(queue.positionOf('e'), 2);
  assert.equal(queue.positionOf('không-tồn-tại'), 0);
});

/* ================= Khung giờ ================= */

/*
 * CẢNH BÁO: mọi Date ở đây dựng bằng thành phần giờ ĐỊA PHƯƠNG. Đổi sang chuỗi
 * ISO là test sẽ xanh hay đỏ tùy múi giờ của máy chạy nó.
 */
const at = (y: number, m: number, d: number, h: number, min = 0): Date => new Date(y, m, d, h, min);

const night: ScheduleWindow = { start: 22 * 60, end: 6 * 60, days: [...ALL_DAYS] };

test('khung 22:00–06:00 vắt qua nửa đêm: 23:30 mở, 02:00 mở, 12:00 đóng', () => {
  assert.equal(crossesMidnight(night), true);
  assert.equal(windowLength(night), 8 * 60);
  assert.equal(isOpenAt([night], at(2026, 0, 5, 23, 30)), true);
  assert.equal(isOpenAt([night], at(2026, 0, 6, 2, 0)), true);
  assert.equal(isOpenAt([night], at(2026, 0, 6, 12, 0)), false);
});

test('ngày của khung là ngày bắt đầu: khung thứ Sáu 23:00–03:00 mở lúc 2h sáng thứ Bảy', () => {
  const friday: ScheduleWindow = { start: 23 * 60, end: 3 * 60, days: [5] };
  // 2026-01-02 là thứ Sáu, 2026-01-03 là thứ Bảy.
  assert.equal(at(2026, 0, 2, 12).getDay(), 5);
  assert.equal(isOpenAt([friday], at(2026, 0, 3, 2, 0)), true);
});

test('…và không mở lúc 2h sáng thứ Sáu', () => {
  const friday: ScheduleWindow = { start: 23 * 60, end: 3 * 60, days: [5] };
  assert.equal(isOpenAt([friday], at(2026, 0, 2, 2, 0)), false);
});

test('biên là nửa khoảng: đúng 09:00 đã mở, đúng 17:00 đã đóng', () => {
  const office: ScheduleWindow = { start: 9 * 60, end: 17 * 60, days: [...ALL_DAYS] };
  assert.equal(isOpenAt([office], at(2026, 0, 5, 8, 59)), false);
  assert.equal(isOpenAt([office], at(2026, 0, 5, 9, 0)), true);
  assert.equal(isOpenAt([office], at(2026, 0, 5, 16, 59)), true);
  assert.equal(isOpenAt([office], at(2026, 0, 5, 17, 0)), false);
});

test('hai khung liền nhau 08:00–12:00 và 12:00–14:00 không lật trạng thái tại 12:00', () => {
  const windows: ScheduleWindow[] = [
    { start: 8 * 60, end: 12 * 60, days: [...ALL_DAYS] },
    { start: 12 * 60, end: 14 * 60, days: [...ALL_DAYS] },
  ];
  assert.equal(isOpenAt(windows, at(2026, 0, 5, 12, 0)), true);

  const boundary = nextBoundary(windows, at(2026, 0, 5, 11, 0));
  assert.equal(boundary?.at, at(2026, 0, 5, 14, 0).getTime());
  assert.equal(boundary?.open, false);
});

test('nextBoundary từ 21:00 trỏ tới 22:00 cùng ngày với open = true', () => {
  const boundary = nextBoundary([night], at(2026, 0, 5, 21, 0));
  assert.equal(boundary?.at, at(2026, 0, 5, 22, 0).getTime());
  assert.equal(boundary?.open, true);
});

test('nextBoundary từ 23:30 trỏ tới 06:00 hôm sau với open = false', () => {
  const boundary = nextBoundary([night], at(2026, 0, 5, 23, 30));
  assert.equal(boundary?.at, at(2026, 0, 6, 6, 0).getTime());
  assert.equal(boundary?.open, false);
});

test('mốc vắt qua ranh giới tháng vẫn tính đúng', () => {
  // 2026-01-31 23:30 -> mốc kế tiếp là 2026-02-01 06:00.
  const boundary = nextBoundary([night], at(2026, 0, 31, 23, 30));
  assert.equal(boundary?.at, at(2026, 1, 1, 6, 0).getTime());
});

test('không có khung nào thì luôn mở và không có mốc nào để hẹn', () => {
  assert.equal(isOpenAt([], at(2026, 0, 5, 3, 0)), true);
  assert.equal(nextBoundary([], at(2026, 0, 5, 3, 0)), null);
});

test('khung 0–1440 là cả ngày, không bị coi là vắt qua nửa đêm', () => {
  const allDay: ScheduleWindow = { start: 0, end: MINUTES_PER_DAY, days: [...ALL_DAYS] };
  assert.equal(crossesMidnight(allDay), false);
  assert.equal(windowLength(allDay), MINUTES_PER_DAY);
  assert.equal(isOpenAt([allDay], at(2026, 0, 5, 0, 0)), true);
  assert.equal(isOpenAt([allDay], at(2026, 0, 5, 23, 59)), true);
  assert.equal(nextBoundary([allDay], at(2026, 0, 5, 12, 0)), null);
});

test('chỉ tải cuối tuần: thứ Hai đóng, Chủ nhật mở', () => {
  const weekend: ScheduleWindow = { start: 0, end: MINUTES_PER_DAY, days: [0, 6] };
  assert.equal(isOpenAt([weekend], at(2026, 0, 5, 12, 0)), false); // thứ Hai
  assert.equal(isOpenAt([weekend], at(2026, 0, 4, 12, 0)), true); // Chủ nhật
});

test('normalizeWindow loại khung start === end và khung có ngày không hợp lệ', () => {
  assert.equal(normalizeWindow({ start: 600, end: 600 }), null);
  assert.equal(normalizeWindow({ start: 600, end: 900, days: [7] }), null);
  assert.equal(normalizeWindow({ start: 600, end: 900, days: [] }), null);
  assert.equal(normalizeWindow({ start: -1, end: 900 }), null);
  assert.equal(normalizeWindow({ start: 600, end: 1441 }), null);
  assert.equal(normalizeWindow(null), null);
  assert.equal(normalizeWindow({ start: 'xin chào', end: '10:00' }), null);

  assert.deepEqual(normalizeWindow({ start: '22:00', end: '06:00', days: [1, 1, 0] }), {
    start: 1320,
    end: 360,
    days: [0, 1],
  });
  // Không ghi ngày nào nghĩa là mọi ngày.
  assert.deepEqual(normalizeWindow({ start: 0, end: 60 })?.days, [...ALL_DAYS]);
});

test('normalizeWindows bỏ qua rác trong storage thay vì làm hỏng cả danh sách', () => {
  const list = normalizeWindows([{ start: '22:00', end: '06:00' }, 'rác', { start: 5, end: 5 }]);
  assert.equal(list.length, 1);
  assert.equal(list[0]?.start, 1320);
  assert.deepEqual(normalizeWindows('không phải mảng'), []);
});

test('parseClock/formatClock đi về được nhau, và từ chối chuỗi rác', () => {
  for (const text of ['00:00', '07:05', '23:59', '24:00']) {
    const minute = parseClock(text);
    assert.notEqual(minute, null);
    assert.equal(formatClock(minute ?? -1), text);
  }
  assert.equal(parseClock('9:30'), 570);
  assert.equal(parseClock('24:30'), null);
  assert.equal(parseClock('25:00'), null);
  assert.equal(parseClock('10:60'), null);
  assert.equal(parseClock('mười giờ'), null);
  assert.equal(parseClock(''), null);
});

/* ================= ScheduleController ================= */

class FakeAlarms implements AlarmPort {
  readonly created: Array<{ name: string; when: number }> = [];
  readonly periodic: Array<{ name: string; minutes: number }> = [];
  readonly cleared: string[] = [];

  create(name: string, when: number): void {
    this.created.push({ name, when });
  }

  createPeriodic(name: string, minutes: number): void {
    this.periodic.push({ name, minutes });
  }

  clear(name: string): void {
    this.cleared.push(name);
  }
}

function controller(startAt: Date) {
  let now = startAt.getTime();
  const alarms = new FakeAlarms();
  const gates: boolean[] = [];
  const ctrl = new ScheduleController({
    alarms,
    onGate: (open) => gates.push(open),
    now: () => now,
  });
  return { alarms, gates, ctrl, jump: (to: Date) => (now = to.getTime()) };
}

test('configure phát trạng thái cửa đúng một lần rồi đặt alarm vào đúng mốc', () => {
  const { alarms, gates, ctrl } = controller(at(2026, 0, 5, 21, 0));
  ctrl.configure(true, [night]);

  assert.deepEqual(gates, [false]);
  assert.equal(ctrl.open, false);
  const last = alarms.created.at(-1);
  assert.equal(last?.name, SCHEDULE_ALARM);
  assert.equal(last?.when, at(2026, 0, 5, 22, 0).getTime());
});

test('sync lại khi chưa tới mốc thì không phát lại onGate', () => {
  const { gates, ctrl, jump } = controller(at(2026, 0, 5, 21, 0));
  ctrl.configure(true, [night]);
  jump(at(2026, 0, 5, 21, 30));
  ctrl.sync();
  assert.deepEqual(gates, [false]);
});

test('alarm dùng when tuyệt đối, không dùng delayInMinutes', () => {
  const { alarms, ctrl } = controller(at(2026, 0, 5, 21, 0));
  ctrl.configure(true, [night]);
  // Không có mốc nào thì vòng lặp dưới chẳng kiểm tra gì mà test vẫn xanh.
  assert.ok(alarms.created.length > 0, 'phải có ít nhất một mốc để mà kiểm tra');
  for (const alarm of alarms.created) {
    // Mốc tuyệt đối là một dấu thời gian epoch, không phải vài phút đếm ngược.
    assert.ok(alarm.when > at(2026, 0, 5, 21, 0).getTime(), 'mốc phải nằm ở tương lai');
    assert.ok(alarm.when > 1_700_000_000_000, 'mốc phải là dấu thời gian tuyệt đối');
  }
});

test('cửa đóng thì bật thêm alarm nhịp tim; cửa mở thì xóa nhịp tim', () => {
  const { alarms, gates, ctrl, jump } = controller(at(2026, 0, 5, 21, 0));
  ctrl.configure(true, [night]);
  assert.deepEqual(alarms.periodic.at(-1), {
    name: HEARTBEAT_ALARM,
    minutes: HEARTBEAT_MINUTES,
  });

  jump(at(2026, 0, 5, 23, 0));
  ctrl.sync();
  assert.deepEqual(gates, [false, true]);
  assert.ok(alarms.cleared.includes(HEARTBEAT_ALARM));
});

test('tắt lịch thì xóa hết alarm và mở cửa', () => {
  const { alarms, gates, ctrl } = controller(at(2026, 0, 5, 21, 0));
  ctrl.configure(true, [night]);
  const before = alarms.created.length;

  ctrl.configure(false, [night]);
  assert.equal(ctrl.open, true);
  assert.deepEqual(gates, [false, true]);
  assert.equal(alarms.created.length, before, 'tắt lịch thì không đặt thêm mốc nào');
  assert.ok(alarms.cleared.includes(SCHEDULE_ALARM));
  assert.ok(alarms.cleared.includes(HEARTBEAT_ALARM));
});

test('handlesAlarm chỉ nhận đúng hai alarm của mình', () => {
  const { ctrl } = controller(at(2026, 0, 5, 21, 0));
  assert.equal(ctrl.handlesAlarm(SCHEDULE_ALARM), true);
  assert.equal(ctrl.handlesAlarm(HEARTBEAT_ALARM), true);
  assert.equal(ctrl.handlesAlarm('alarm-của-nhóm-khác'), false);
});
