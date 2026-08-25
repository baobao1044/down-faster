import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ConcurrencyController,
  parseRetryAfterMs,
  pressureFromStatus,
  statusFromMessage,
  type ConcurrencyDecision,
  type ConcurrencyOptions,
} from '../src/engine/adaptive/concurrency';

import {
  HeaderStore,
  RuleIdAllocator,
  RULE_ID_BASE,
  allRuleIds,
  buildRuleSpec,
  captureFromDownloadItem,
  captureFromRequestHeaders,
  classifyHeader,
  emptyCapture,
  nextTier,
  planReplay,
  redact,
  synthesizeFromReferrer,
} from '../src/engine/adaptive/headers';

import {
  DEFAULT_STREAM,
  StreamDownload,
  createPortSink,
  discoverTotalSize,
  parseContentRange,
  parseUnsatisfiedTotal,
  type StreamSink,
} from '../src/engine/adaptive/streaming';

import {
  MirrorPool,
  compareFingerprints,
  normalizeEtag,
  sampleDigest,
  verifyByContent,
  type MirrorFingerprint,
  type RangeReader,
} from '../src/engine/adaptive/mirrors';

const KB = 1024;
const MB = 1024 * KB;

/* ==================================================================
 * AIMD — bộ dò số kết nối
 * ================================================================== */

/**
 * Trình mô phỏng cửa sổ đo. Đồng hồ hoàn toàn giả nên mọi test ở đây chạy tức
 * thì và cho cùng một kết quả trên mọi máy.
 */
class Sim {
  t = 0;
  constructor(
    readonly c: ConcurrencyController,
    readonly windowMs: number,
  ) {}

  /** Chạy trọn một cửa sổ với throughput cho trước (byte/giây). */
  run(throughput: number, active?: number): ConcurrencyDecision {
    const bytes = Math.round((throughput * this.windowMs) / 1000);
    this.c.noteBytes(bytes, this.t);
    this.c.noteActive(active ?? this.c.limit, this.t);
    this.t += this.windowMs;
    return this.c.tick(this.t);
  }
}

function sim(over: Partial<ConcurrencyOptions> = {}): Sim {
  const windowMs = over.windowMs ?? 1000;
  return new Sim(
    new ConcurrencyController({ start: 2, max: 8, settleWindows: 0, windowMs, ...over }),
    windowMs,
  );
}

test('AIMD: throughput còn tăng thì nhích thêm kết nối', () => {
  const s = sim();
  assert.equal(s.run(1_000_000).kind, 'grow');
  assert.equal(s.c.limit, 3);

  const second = s.run(2_000_000);
  assert.equal(second.kind, 'grow');
  assert.equal(second.cause, 'improving');
  assert.equal(s.c.limit, 4);
});

test('AIMD: throughput bão hòa thì đứng lại chứ không leo mãi', () => {
  const s = sim();
  s.run(1_000_000); // 2 -> 3
  const flat = s.run(1_000_000); // thêm kết nối chẳng nhanh hơn
  assert.equal(flat.kind, 'hold');
  assert.equal(flat.cause, 'saturated');
  assert.equal(s.c.limit, 3);

  s.run(1_000_000);
  assert.equal(s.c.limit, 3, 'đã bão hòa thì không được tự leo tiếp');
});

test('AIMD: tăng xong chậm đi thì lùi về đúng mức cũ', () => {
  const s = sim();
  s.run(1_000_000); // 2 -> 3
  const back = s.run(400_000); // tụt sâu dưới regressRatio
  assert.equal(back.kind, 'shrink');
  assert.equal(back.cause, 'regressed');
  assert.equal(s.c.limit, 2);
});

test('AIMD: 429 giảm một nửa và ghi nhớ mức đã gây lỗi thành trần tạm', () => {
  const c = new ConcurrencyController({ start: 8, max: 8 });
  c.noteStatus(429, 0);

  assert.equal(c.limit, 4);
  const snap = c.snapshot();
  assert.equal(snap.ceiling, 7, 'mức 8 vừa gây 429 nên trần phải nằm dưới nó');
  assert.equal(snap.effectiveMax, 7);
  assert.equal(snap.throttleEvents, 1);
});

test('AIMD: 429 không bao giờ leo lại đúng mức đã bị chặn', () => {
  const s = sim({ start: 8, max: 8 });
  s.c.noteStatus(429, s.t);
  s.t = 10_000; // vượt cooldown mặc định 5 giây

  for (let i = 0; i < 30; i++) s.run(1_000_000 * (i + 1));
  assert.ok(s.c.limit <= 7, `leo lại tới ${s.c.limit}, đúng bức tường vừa bị chặn`);
});

test('AIMD: Retry-After tạo cooldown và chặn mọi kết nối mới', () => {
  const c = new ConcurrencyController({ start: 8, max: 8 });
  // Tham số thứ ba tính bằng mili-giây, cùng đơn vị với parseRetryAfterMs().
  c.noteStatus(503, 1000, 30_000);

  assert.equal(c.allowedAt(2000), 0, 'trong cooldown thì không mở kết nối mới');
  assert.equal(c.allowedAt(30_999), 0);
  assert.equal(c.allowedAt(31_000), c.limit, 'hết hạn thì trả lại đúng mức hiện hành');

  const decision = c.tick(2000);
  assert.equal(decision.kind, 'wait');
  assert.equal(decision.cause, 'cooldown');
});

test('AIMD: cửa sổ thiếu kết nối chạy bị bỏ qua, không kéo mức xuống', () => {
  const s = sim({ start: 4, max: 8 });

  // Bẫy cuối file: chỉ còn một piece nên chỉ một worker chạy, throughput tụt.
  const d1 = s.run(50_000, 1);
  assert.equal(d1.cause, 'inconclusive');
  assert.equal(s.c.limit, 4);

  const d2 = s.run(10_000, 1);
  assert.equal(d2.kind, 'hold');
  assert.equal(s.c.limit, 4, 'cửa sổ không kết luận được thì tuyệt đối không đổi mức');
});

test('AIMD: không bao giờ vượt trần người dùng đặt', () => {
  const s = sim({ start: 1, max: 3 });
  for (let i = 1; i <= 20; i++) s.run(1_000_000 * i);
  assert.equal(s.c.limit, 3);
});

test('AIMD: không bao giờ tụt xuống dưới min', () => {
  const c = new ConcurrencyController({ start: 8, max: 8, min: 2 });
  for (let i = 0; i < 10; i++) c.noteStatus(429, i * 1000);
  assert.equal(c.limit, 2);
  assert.ok(c.snapshot().ceiling >= 2);
});

test('AIMD: cả đợt 429 do nhiều worker cùng báo chỉ bị phạt một lần', () => {
  const burst = new ConcurrencyController({ start: 8, max: 8, min: 1, cooldownMs: 5000 });
  // Tám worker cùng ăn 429 trong vài mili-giây: đó là MỘT sự kiện, không phải tám.
  for (let i = 0; i < 8; i++) burst.noteStatus(429, i);

  assert.equal(burst.limit, 4, 'phạt tám lần sẽ đẩy thẳng xuống min và giết tốc độ');
  const snap = burst.snapshot();
  assert.equal(snap.ceiling, 7);
  assert.equal(snap.throttleEvents, 1);
  assert.equal(snap.cooldownUntil, 5000, 'cooldown cũng không được nhân đôi tám lần');

  // Đợt thật sự thứ hai, sau khi cooldown đã hết, vẫn phải bị phạt bình thường.
  burst.noteStatus(429, 5000);
  assert.equal(burst.limit, 2);
  assert.equal(burst.snapshot().throttleEvents, 2);
});

test('AIMD: Retry-After vẫn kéo dài được cooldown đang chạy', () => {
  const c = new ConcurrencyController({ start: 8, max: 8, cooldownMs: 5000 });
  c.noteStatus(429, 0);
  assert.equal(c.snapshot().cooldownUntil, 5000);

  // Worker thứ hai của cùng đợt mang về một Retry-After dài hơn: lời server dặn
  // luôn thắng, dù ta đã quyết định không phạt thêm lần nữa.
  c.noteStatus(429, 100, 60_000);
  assert.equal(c.snapshot().cooldownUntil, 60_100);
  assert.equal(c.snapshot().throttleEvents, 1);
});

test('AIMD: cửa sổ không có byte nào tuyệt đối không phải lý do để mở thêm kết nối', () => {
  const s = sim({ start: 2, max: 8 });

  // Server treo hẳn: tám cửa sổ liền không có byte nào. Hiểu số 0 là một số đo
  // hợp lệ thì bộ dò sẽ bồi thêm kết nối cho một server đang không trả lời.
  for (let i = 0; i < 8; i++) {
    const d = s.run(0);
    assert.equal(d.kind, 'hold');
    assert.equal(d.cause, 'inconclusive');
  }
  assert.equal(s.c.limit, 2);

  // Có byte trở lại thì bộ dò phải làm việc bình thường ngay.
  assert.equal(s.run(1_000_000).kind, 'grow');
});

test('AIMD: trần do lỗi đặt ra được nới lại sau ceilingRelaxMs', () => {
  const c = new ConcurrencyController({ start: 8, max: 8, ceilingRelaxMs: 60_000 });
  c.noteStatus(429, 0);
  assert.equal(c.snapshot().ceiling, 7);

  c.tick(59_000);
  assert.equal(c.snapshot().ceiling, 7, 'chưa đủ thời gian thì chưa nới');

  c.tick(60_000);
  assert.equal(c.snapshot().ceiling, 8);
});

test('AIMD: nhiều lần đứt kết nối trong một cửa sổ được coi là bị bóp', () => {
  const c = new ConcurrencyController({ start: 8, max: 8, resetTolerance: 2 });
  c.noteFailure('reset', 0);
  assert.equal(c.limit, 8, 'một lần đứt là chuyện thường của mạng');

  c.noteFailure('reset', 10);
  assert.equal(c.limit, 4);
  assert.equal(c.snapshot().ceiling, 7);
});

test('AIMD: cửa sổ ngay sau khi đổi mức bị bỏ qua để chờ kết nối mới đạt tốc', () => {
  const s = sim({ settleWindows: 1 });
  s.run(1_000_000); // 2 -> 3
  const settling = s.run(10);
  assert.equal(settling.cause, 'settling');
  assert.equal(s.c.limit, 3, 'số đo ngay sau khi đổi mức chưa đủ tin để lùi');
});

test('AIMD: đứng yên đủ lâu thì thử nhích lên một lần nữa', () => {
  const s = sim({ reprobeAfterMs: 5000 });
  s.run(1_000_000); // 2 -> 3, đổi mức tại t = 1000

  let last = s.run(1_000_000); // bão hòa
  while (s.t < 6000) last = s.run(1_000_000);

  assert.equal(last.cause, 'reprobe');
  assert.equal(s.c.limit, 4);
});

test('AIMD: reset() đưa mọi thứ về mốc ban đầu', () => {
  const c = new ConcurrencyController({ start: 3, max: 8 });
  c.noteStatus(429, 0);
  c.reset();
  assert.equal(c.limit, 3);
  assert.equal(c.snapshot().ceiling, 8);
  assert.equal(c.snapshot().cooldownUntil, 0);
});

test('parseRetryAfterMs đọc được cả số giây lẫn HTTP-date', () => {
  assert.equal(parseRetryAfterMs('30', 0), 30_000);
  assert.equal(parseRetryAfterMs('  0 ', 0), 0);

  const base = Date.parse('Wed, 21 Oct 2015 07:28:00 GMT');
  assert.equal(parseRetryAfterMs('Wed, 21 Oct 2015 07:28:30 GMT', base), 30_000);
  assert.equal(parseRetryAfterMs('Wed, 21 Oct 2015 07:27:00 GMT', base), 0, 'mốc đã trôi qua thì chờ 0');

  assert.equal(parseRetryAfterMs(null, 0), null);
  assert.equal(parseRetryAfterMs('lúc nào đó', 0), null);
});

test('parseRetryAfterMs từ chối rác mà Date.parse của V8 vẫn nhận bừa', () => {
  const now = Date.parse('Wed, 21 Oct 2015 07:28:00 GMT');

  // Cả ba chuỗi này đều được Date.parse dịch thành một ngày có thật quanh năm
  // 2001. Nhận bừa thì hoặc ra 0 — mất luôn cooldown mặc định — hoặc, với một
  // đồng hồ không phải giờ tường, ra khoảng chờ hàng chục năm.
  assert.equal(parseRetryAfterMs('1.5', now), null);
  assert.equal(parseRetryAfterMs('-5', now), null);
  assert.equal(parseRetryAfterMs('0.5', now), null);
  assert.equal(parseRetryAfterMs('30s', now), null);

  // Cả ba dạng HTTP-date hợp lệ vẫn phải đi lọt.
  assert.equal(parseRetryAfterMs('Wed, 21 Oct 2015 07:28:30 GMT', now), 30_000);
  assert.equal(parseRetryAfterMs('Wednesday, 21-Oct-15 07:28:30 GMT', now), 30_000);
  assert.equal(parseRetryAfterMs('Wed Oct 21 07:28:30 2015', now), 30_000);
});

test('AIMD: Retry-After bằng 0 không được xóa cơ chế gộp cả đợt 429', () => {
  // Server trả `Retry-After: 0` kèm 429 là chuyện có thật. Nếu con số 0 đó được
  // coi là một chỉ thị chờ hợp lệ thì cooldown dài đúng 0 mili-giây, và tám
  // worker của cùng một đợt sẽ bị phạt đủ tám lần: mức tụt từ 8 xuống 1 và trần
  // cũng xuống 1, tức là một cú 429 duy nhất giết tốc độ của cả lượt tải.
  const c = new ConcurrencyController({ start: 8, max: 8, min: 1, cooldownMs: 5000 });
  for (let i = 0; i < 8; i++) c.noteStatus(429, i, 0);

  assert.equal(c.limit, 4, 'vẫn phải là một lần phạt duy nhất');
  const snap = c.snapshot();
  assert.equal(snap.throttleEvents, 1);
  assert.equal(snap.ceiling, 7);
  assert.equal(snap.cooldownUntil, 5000, 'rơi về nhịp mặc định thay vì không chờ gì');
});

test('AIMD: chạm trần rồi thì một dao động bình thường không được kéo tụt xuống', () => {
  // Sau khi applyLimit() từ chối vì đã chạm trần, phép thử nâng cũ không còn gì
  // để chấm điểm. Giữ lại nó thì cửa sổ sau so với một mốc đã cũ hai cửa sổ và
  // một nhịp mạng chậm bình thường đủ để đá mức ra khỏi trần.
  const s = sim({ start: 2, max: 3, min: 1 });
  assert.equal(s.run(1_000_000).kind, 'grow'); // 2 -> 3, chạm trần
  assert.equal(s.run(2_000_000).cause, 'capped');
  s.run(1_500_000);

  const wobble = s.run(800_000);
  assert.equal(s.c.limit, 3, `dao động thường không được kéo tụt khỏi trần (${wobble.cause})`);
});

test('statusFromMessage moi được mã HTTP khỏi chuỗi lỗi của fetch worker', () => {
  assert.equal(statusFromMessage('HTTP 429 Too Many Requests'), 429);
  assert.equal(statusFromMessage('HTTP 503 Service Unavailable'), 503);
  assert.equal(statusFromMessage('Thiếu 100 byte'), null);
  assert.equal(statusFromMessage('Đã hủy'), null);
});

test('pressureFromStatus phân loại đúng loại áp lực', () => {
  assert.equal(pressureFromStatus(429), 'throttled');
  assert.equal(pressureFromStatus(503), 'throttled');
  assert.equal(pressureFromStatus(408), 'timeout');
  assert.equal(pressureFromStatus(200), null);
  assert.equal(pressureFromStatus(404), null);
});

/* ==================================================================
 * Mirror — xác thực và chia việc
 * ================================================================== */

const fp = (over: Partial<MirrorFingerprint> = {}): MirrorFingerprint => ({
  size: 1000,
  etag: '"abc"',
  lastModified: null,
  acceptRanges: true,
  ...over,
});

test('normalizeEtag bóc được W/ và cặp dấu nháy', () => {
  assert.deepEqual(normalizeEtag('"abc"'), { value: 'abc', weak: false });
  assert.deepEqual(normalizeEtag('W/"abc"'), { value: 'abc', weak: true });
  assert.deepEqual(normalizeEtag('  w/"abc"  '), { value: 'abc', weak: true });
  assert.equal(normalizeEtag(null), null);
  assert.equal(normalizeEtag('   '), null);
});

test('mirror: kích thước lệch là bằng chứng chắc chắn khác file', () => {
  const r = compareFingerprints(fp(), fp({ size: 2000 }), false);
  assert.equal(r.verdict, 'different');
  assert.match(r.reason, /kích thước/);
});

test('mirror: kích thước và ETag MẠNH đều khớp thì chắc chắn cùng file', () => {
  assert.equal(compareFingerprints(fp(), fp(), false).verdict, 'same');
});

test('mirror: ETag YẾU khớp chỉ là "likely", không đủ để chia piece', () => {
  // RFC 9110 đòi so sánh MẠNH cho mọi kết luận về byte. `W/` chỉ hứa tương đương
  // về ngữ nghĩa, mà ghép hai bản chỉ tương đương ngữ nghĩa là ra file hỏng —
  // đúng thứ compareFingerprints tồn tại để chặn. Test cũ đòi 'same' ở đây, tức
  // là đòi chính cái lỗi mà module đang phòng.
  const oneWeak = compareFingerprints(fp(), fp({ etag: 'W/"abc"' }), false);
  assert.equal(oneWeak.verdict, 'likely');
  assert.match(oneWeak.reason, /ETag yếu/);

  const bothWeak = compareFingerprints(fp({ etag: 'W/"abc"' }), fp({ etag: 'W/"abc"' }), false);
  assert.equal(bothWeak.verdict, 'likely', 'hai bên cùng yếu vẫn không phải bằng chứng');
});

test('mirror: ETag lệch giữa hai origin khác nhau chỉ là "likely", không phải khác file', () => {
  const r = compareFingerprints(fp(), fp({ etag: '"xyz"' }), false);
  assert.equal(r.verdict, 'likely');
});

test('mirror: cùng origin mà ETag lệch thì đúng là khác file', () => {
  assert.equal(compareFingerprints(fp(), fp({ etag: '"xyz"' }), true).verdict, 'different');
});

test('mirror: thiếu kích thước ở một bên thì không kết luận gì', () => {
  assert.equal(compareFingerprints(fp(), fp({ size: null }), false).verdict, 'unknown');
  assert.equal(compareFingerprints(fp({ size: null }), fp(), true).verdict, 'unknown');
});

test('mirror: thiếu ETag nhưng khớp kích thước thì phải xác minh bằng nội dung', () => {
  const r = compareFingerprints(fp({ etag: null }), fp({ etag: null }), false);
  assert.equal(r.verdict, 'likely');
});

test('mirror: acquire chọn nguồn nhanh hơn', () => {
  const pool = new MirrorPool([
    { id: 'a', url: 'https://a.test/f' },
    { id: 'b', url: 'https://b.test/f' },
  ]);
  pool.notePieceDone('a', 10 * MB, 1000);
  pool.notePieceDone('b', 1 * MB, 1000);

  assert.equal(pool.acquire()?.id, 'a');
  assert.equal(pool.best()?.id, 'a');
});

test('mirror: nguồn chưa có số đo được ép chạy thử ít nhất một lần', () => {
  const pool = new MirrorPool([
    { id: 'a', url: 'https://a.test/f' },
    { id: 'b', url: 'https://b.test/f' },
  ]);
  pool.notePieceDone('a', 50 * MB, 1000);

  assert.equal(
    pool.acquire()?.id,
    'b',
    'nếu chỉ xếp theo tốc độ thì b không bao giờ có số đo để cạnh tranh',
  );
});

test('mirror: acquire tôn trọng maxPerMirror rồi trả null', () => {
  const pool = new MirrorPool([{ id: 'a', url: 'https://a.test/f' }], { maxPerMirror: 2 });
  assert.equal(pool.acquire()?.id, 'a');
  assert.equal(pool.acquire()?.id, 'a');
  assert.equal(pool.acquire(), null);

  pool.release('a');
  assert.equal(pool.acquire()?.id, 'a');
});

test('mirror: requireRanges loại nguồn không hỗ trợ tải theo khoảng byte', () => {
  const pool = new MirrorPool([]);
  pool.add({ id: 'a', url: 'https://a.test/f' }, fp({ acceptRanges: false }));
  pool.add({ id: 'b', url: 'https://b.test/f' }, fp({ acceptRanges: true }));

  assert.equal(pool.acquire({ requireRanges: true })?.id, 'b');
});

test('mirror: exclude bỏ qua đúng nguồn được nêu tên', () => {
  const pool = new MirrorPool([
    { id: 'a', url: 'https://a.test/f' },
    { id: 'b', url: 'https://b.test/f' },
  ]);
  assert.equal(pool.acquire({ exclude: new Set(['a']) })?.id, 'b');
});

test('mirror: đủ lỗi liên tiếp thì vào thời gian phạt, phạt nhân đôi, rồi chết hẳn', () => {
  let clock = 0;
  const pool = new MirrorPool(
    [{ id: 'a', url: 'https://a.test/f' }],
    { failuresToProbation: 3, probationBackoffMs: 5000, deadAfterProbations: 3 },
    () => clock,
  );

  for (let i = 0; i < 3; i++) pool.noteFailure('a', 'network');
  let stat = pool.stats()[0]!;
  assert.equal(stat.state, 'probation');
  assert.equal(stat.retryAt, 5000);
  assert.equal(pool.acquire(), null, 'đang bị phạt thì không được nhận việc');

  clock = 5000;
  assert.equal(pool.acquire()?.id, 'a', 'hết hạn phạt thì được chạy thử lại');
  pool.release('a');

  for (let i = 0; i < 3; i++) pool.noteFailure('a', 'network');
  stat = pool.stats()[0]!;
  assert.equal(stat.state, 'probation');
  assert.equal(stat.retryAt, 15_000, 'lần phạt thứ hai phải dài gấp đôi');

  clock = 15_000;
  for (let i = 0; i < 3; i++) pool.noteFailure('a', 'network');
  assert.equal(pool.stats()[0]!.state, 'dead');
  assert.equal(pool.usable, 0);
});

test('mirror: tải được vài MB rồi đứt, lặp mãi, vẫn phải bị phạt', () => {
  let clock = 0;
  const pool = new MirrorPool(
    [{ id: 'a', url: 'https://a.test/f' }],
    { failuresToProbation: 3 },
    () => clock,
  );

  // Kiểu hỏng phổ biến nhất của mirror. Nếu vài byte đầu đã xóa bộ đếm lỗi thì
  // nguồn này không bao giờ bị loại và pool cứ giao việc cho nó mãi.
  for (let i = 0; i < 3; i++) {
    pool.noteBytes('a', 4 * MB, 1000);
    pool.noteFailure('a', 'network');
  }

  assert.equal(pool.stats()[0]!.state, 'probation');
});

test('mirror: piece chạy trọn vẹn mới xóa được bộ đếm lỗi', () => {
  const pool = new MirrorPool([{ id: 'a', url: 'https://a.test/f' }], { failuresToProbation: 3 });

  pool.noteFailure('a', 'network');
  pool.noteFailure('a', 'network');
  pool.notePieceDone('a', 8 * MB, 1000);
  assert.equal(pool.stats()[0]!.consecutiveFailures, 0, 'thành công thật thì xóa sạch');

  pool.noteFailure('a', 'network');
  assert.equal(pool.stats()[0]!.state, 'active', 'một lỗi sau khi đã chạy tốt chưa đủ để phạt');
});

test('mirror: 404 hoặc sai file thì chết ngay, chờ thêm là vô nghĩa', () => {
  const pool = new MirrorPool([
    { id: 'a', url: 'https://a.test/f' },
    { id: 'b', url: 'https://b.test/f' },
  ]);
  pool.noteFailure('a', 'notfound');
  pool.noteFailure('b', 'mismatch');
  assert.equal(pool.usable, 0);
  assert.equal(pool.acquire(), null);
  assert.match(pool.stats()[0]!.lastError ?? '', /không còn file/);
});

test('mirror: shouldAbandon từ chối khi chưa đo đủ mẫu', () => {
  const pool = new MirrorPool([
    { id: 'slow', url: 'https://s.test/f' },
    { id: 'fast', url: 'https://f.test/f' },
  ]);
  pool.notePieceDone('fast', 40 * MB, 1000);

  assert.equal(pool.shouldAbandon('slow', 1 * MB, 5000), false, 'chưa đủ byte');
  assert.equal(pool.shouldAbandon('slow', 4 * MB, 1000), false, 'chưa đủ thời gian');
});

test('mirror: shouldAbandon từ chối khi không còn nguồn nào thay thế', () => {
  const pool = new MirrorPool(
    [
      { id: 'slow', url: 'https://s.test/f' },
      { id: 'fast', url: 'https://f.test/f' },
    ],
    { maxPerMirror: 2 },
  );
  pool.notePieceDone('fast', 40 * MB, 1000);

  // Lấp kín chỗ của nguồn nhanh: bỏ piece đang dở lúc này chỉ là vứt tiến độ.
  pool.acquire({ exclude: new Set(['slow']) });
  pool.acquire({ exclude: new Set(['slow']) });

  assert.equal(pool.shouldAbandon('slow', 8 * MB, 8000), false);
});

test('mirror: shouldAbandon đồng ý khi đủ cả ba điều kiện', () => {
  const pool = new MirrorPool([
    { id: 'slow', url: 'https://s.test/f' },
    { id: 'fast', url: 'https://f.test/f' },
  ]);
  pool.notePieceDone('fast', 40 * MB, 1000); // 40 MB/s

  // 8 MB trong 8 giây = 1 MB/s, chậm hơn 40 lần, vượt xa slowFactor 4.
  assert.equal(pool.shouldAbandon('slow', 8 * MB, 8000), true);
});

test('mirror: nguồn chưa đo được chỉ giữ MỘT kết nối thử, không ôm cả pool', () => {
  const pool = new MirrorPool(
    [
      { id: 'fast', url: 'https://fast.test/f' },
      { id: 'hole', url: 'https://hole.test/f' },
    ],
    { maxPerMirror: 8 },
  );
  pool.notePieceDone('fast', 100 * MB, 1000);

  // 'hole' nhận kết nối nhưng không bao giờ trả byte nào, nên nó vĩnh viễn không
  // có mẫu. Ưu tiên "chưa đo được" mà không giới hạn thì nó hút trọn tám kết nối
  // trong khi nguồn 100 MB/s ngồi không, và phải chờ đủ ba lần timeout mới thoát.
  const picks: string[] = [];
  for (let i = 0; i < 8; i++) picks.push(pool.acquire()?.id ?? 'null');

  assert.equal(picks.filter((id) => id === 'hole').length, 1, 'chạy thử là một kết nối');
  assert.equal(picks.filter((id) => id === 'fast').length, 7);
});

test('mirror: piece về đích xóa luôn hạn phạt còn treo', () => {
  let clock = 0;
  const pool = new MirrorPool(
    [{ id: 'a', url: 'https://a.test/f' }],
    { failuresToProbation: 2, probationBackoffMs: 5000 },
    () => clock,
  );

  pool.noteFailure('a', 'network');
  pool.noteFailure('a', 'network');
  assert.equal(pool.stats()[0]!.state, 'probation');

  clock = 5000;
  pool.notePieceDone('a', 8 * MB, 1000);
  const stat = pool.stats()[0]!;
  assert.equal(stat.state, 'active');
  assert.equal(stat.retryAt, null, 'trạng thái active mà vẫn kèm mốc chờ là tự mâu thuẫn');
});

test('mirror: validatorFor trả đúng ETag của từng nguồn, không dùng chung', () => {
  const pool = new MirrorPool([]);
  pool.add({ id: 'a', url: 'https://a.test/f' }, fp({ etag: '"aaa"' }));
  pool.add({ id: 'b', url: 'https://b.test/f' }, fp({ etag: '"bbb"' }));

  assert.equal(pool.validatorFor('a')?.etag, '"aaa"');
  assert.equal(pool.validatorFor('b')?.etag, '"bbb"');
  assert.equal(pool.validatorFor('c'), null);
});

/* ---------- Lấy mẫu nội dung ---------- */

function fakeFile(seed: number, size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) bytes[i] = (i * 31 + seed * 7) & 0xff;
  return bytes;
}

function readerFor(files: Record<string, Uint8Array>): RangeReader {
  return async (url, start, end) => {
    const data = files[url];
    if (!data) throw new Error(`không có file giả cho ${url}`);
    return data.subarray(start, end + 1);
  };
}

test('sampleDigest cho cùng một mã băm với cùng nội dung', async () => {
  const size = 300 * KB;
  const read = readerFor({ 'https://a.test/f': fakeFile(1, size) });
  const a = await sampleDigest('https://a.test/f', size, read);
  const b = await sampleDigest('https://a.test/f', size, read);
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('sampleDigest đổi khi nội dung đổi, kể cả chỉ ở cuối file', async () => {
  const size = 300 * KB;
  const base = fakeFile(1, size);
  const tail = fakeFile(1, size);
  tail[size - 1] = (tail[size - 1]! ^ 0xff) & 0xff;

  const read = readerFor({ 'https://a.test/f': base, 'https://b.test/f': tail });
  const a = await sampleDigest('https://a.test/f', size, read);
  const b = await sampleDigest('https://b.test/f', size, read);
  assert.notEqual(a, b, 'lấy mẫu cả phần cuối chính là để bắt được ca này');
});

test('verifyByContent phân xử được ca "likely"', async () => {
  const size = 300 * KB;
  const same = readerFor({
    'https://a.test/f': fakeFile(2, size),
    'https://b.test/f': fakeFile(2, size),
  });
  const differ = readerFor({
    'https://a.test/f': fakeFile(2, size),
    'https://b.test/f': fakeFile(3, size),
  });

  const ok = await verifyByContent(
    { url: 'https://a.test/f', size },
    { url: 'https://b.test/f', size },
    same,
  );
  assert.equal(ok.verdict, 'same');

  const bad = await verifyByContent(
    { url: 'https://a.test/f', size },
    { url: 'https://b.test/f', size },
    differ,
  );
  assert.equal(bad.verdict, 'different');
});

/* ==================================================================
 * Headers — cái gì đặt được, cái gì không
 * ================================================================== */

test('classifyHeader biết header nào fetch() không bao giờ đặt được', () => {
  for (const name of ['referer', 'Origin', 'user-agent', 'Cookie']) {
    assert.equal(classifyHeader(name), 'network', `${name} phải đi qua tầng mạng`);
  }
  for (const name of ['host', 'content-length', 'sec-fetch-mode', 'proxy-authorization']) {
    assert.equal(classifyHeader(name), 'never');
  }
  for (const name of ['range', 'if-range', 'accept-encoding']) {
    assert.equal(classifyHeader(name), 'engine');
  }
  for (const name of ['authorization', 'x-token', 'accept-language']) {
    assert.equal(classifyHeader(name), 'fetch');
  }
});

test('planReplay bậc 0 không đụng gì, bậc 1 chỉ sinh header fetch đặt được', () => {
  const cap = emptyCapture(0);
  cap.referer = 'https://site.test/page';
  cap.capturedFrom = 'https://site.test';
  cap.extra['authorization'] = 'Bearer xyz';

  const tier0 = planReplay(cap, 'https://site.test/file.iso', 0);
  assert.deepEqual(tier0.fetchHeaders, {});
  assert.equal(tier0.networkHeaders.length, 0);

  const tier1 = planReplay(cap, 'https://site.test/file.iso', 1);
  assert.equal(tier1.fetchHeaders['authorization'], 'Bearer xyz');
  assert.equal(tier1.networkHeaders.length, 0, 'bậc 1 không được đụng tới tầng mạng');
});

test('planReplay không bao giờ gửi bí mật sang origin khác nơi thu được', () => {
  const cap = emptyCapture(0);
  cap.capturedFrom = 'https://site.test';
  cap.referer = 'https://site.test/page';
  cap.userAgent = 'Mozilla/5.0 (test)';
  cap.cookie = 'session=bimat';
  cap.extra['authorization'] = 'Bearer xyz';

  const plan = planReplay(cap, 'https://cdn.other.test/file.iso', 3);

  assert.equal(plan.fetchHeaders['authorization'], undefined);
  assert.ok(
    !plan.networkHeaders.some((h) => h.header === 'cookie'),
    'Cookie không được đi theo redirect sang CDN của bên thứ ba',
  );
  assert.ok(plan.dropped.some((d) => d.header === 'cookie'));
  assert.ok(plan.dropped.some((d) => d.header === 'authorization'));
  // User-Agent không phải bí mật nên vẫn được phát lại.
  assert.ok(plan.networkHeaders.some((h) => h.header === 'user-agent'));
});

test('planReplay gửi Cookie khi và chỉ khi đúng origin đã thu được', () => {
  const cap = emptyCapture(0);
  cap.capturedFrom = 'https://site.test';
  cap.cookie = 'session=bimat';

  const plan = planReplay(cap, 'https://site.test/file.iso', 3);
  const cookie = plan.networkHeaders.find((h) => h.header === 'cookie');
  assert.equal(cookie?.value, 'session=bimat');
});

test('synthesizeFromReferrer: cùng origin gửi cả đường dẫn, khác origin chỉ gửi origin', () => {
  const same = synthesizeFromReferrer('https://site.test/a/b?q=1', 'https://site.test/f.iso');
  assert.equal(same.referer, 'https://site.test/a/b?q=1');
  assert.equal(same.origin, 'https://site.test');

  const cross = synthesizeFromReferrer('https://site.test/a/b?q=1', 'https://cdn.test/f.iso');
  assert.equal(cross.referer, 'https://site.test/', 'khác origin thì không rò đường dẫn duyệt web');
  assert.equal(cross.origin, 'https://site.test');

  const downgrade = synthesizeFromReferrer('https://site.test/a', 'http://cdn.test/f.iso');
  assert.equal(downgrade.referer, null, 'https xuống http thì không gửi gì');

  assert.equal(synthesizeFromReferrer('https://site.test/a', 'https://site.test/f', 'off').referer, null);
  assert.equal(
    synthesizeFromReferrer('https://site.test/a/b#x', 'https://cdn.test/f', 'full').referer,
    'https://site.test/a/b',
    'fragment không bao giờ được đi kèm Referer',
  );
});

test('nextTier chỉ leo với mã chống hotlink và dừng ở bậc cuối', () => {
  assert.equal(nextTier(0, 403, true), 1);
  assert.equal(nextTier(1, 401, true), 2);
  assert.equal(nextTier(2, 451, true), 3);
  assert.equal(nextTier(3, 403, true), null, 'hết bài thì trả về cho trình duyệt');
  assert.equal(nextTier(0, 404, true), null, '404 không phải chuyện thiếu header');
  assert.equal(nextTier(0, 403, false), null, 'không bắt được gì thì leo bậc cũng vô ích');
});

test('buildRuleSpec bỏ qua khi không có gì cho tầng mạng', () => {
  const plan = planReplay(emptyCapture(0), 'https://site.test/f.iso', 1);
  assert.equal(buildRuleSpec(RULE_ID_BASE, 'https://site.test/f.iso', plan), null);
});

test('buildRuleSpec khóa rule vào request của chính engine bằng tabIds [-1]', () => {
  const cap = emptyCapture(0);
  cap.referer = 'https://site.test/page';
  cap.capturedFrom = 'https://site.test';

  const plan = planReplay(cap, 'https://site.test/f.iso', 2);
  const spec = buildRuleSpec(RULE_ID_BASE, 'https://site.test/f.iso', plan);

  assert.ok(spec);
  assert.deepEqual(spec!.tabIds, [-1]);
  assert.equal(spec!.urlFilter, '|https://site.test/f.iso|');
  assert.equal(spec!.requestDomains, null);
  assert.ok(spec!.requestHeaders.some((h) => h.header === 'referer'));
});

test('buildRuleSpec lui về requestDomains khi URL chứa ký tự đặc biệt của DNR', () => {
  const cap = emptyCapture(0);
  cap.referer = 'https://site.test/page';
  cap.capturedFrom = 'https://site.test';
  const target = 'https://site.test/f.iso?token=a|b';

  const plan = planReplay(cap, target, 2);
  const spec = buildRuleSpec(RULE_ID_BASE, target, plan);

  assert.ok(spec);
  assert.equal(spec!.urlFilter, null);
  assert.deepEqual(spec!.requestDomains, ['site.test']);
});

test('RuleIdAllocator cấp id ổn định cho một task và thu hồi được', () => {
  const alloc = new RuleIdAllocator();
  const first = alloc.take('task-1');
  assert.equal(alloc.take('task-1'), first, 'cùng một task phải nhận lại đúng id cũ');

  const second = alloc.take('task-2');
  assert.notEqual(second, first);
  assert.deepEqual(alloc.all(), [first, second].sort((a, b) => a - b));

  alloc.release('task-1');
  assert.deepEqual(alloc.all(), [second]);
  assert.equal(allRuleIds().length, 256);
  assert.equal(allRuleIds()[0], RULE_ID_BASE);
});

test('HeaderStore khớp chính xác trước, rồi mới lui về cùng thư mục', () => {
  let clock = 0;
  const store = new HeaderStore({ now: () => clock, ttlMs: 10_000 });

  const exact = emptyCapture(0);
  exact.referer = 'https://site.test/exact';
  const folder = emptyCapture(0);
  folder.referer = 'https://site.test/folder';

  store.remember('https://site.test/dl/file.iso', exact);
  store.remember('https://site.test/dl/other.iso', folder);

  assert.equal(store.lookup('https://site.test/dl/file.iso')?.referer, 'https://site.test/exact');
  assert.equal(
    store.lookup('https://site.test/dl/third.iso')?.referer,
    'https://site.test/folder',
    'không khớp chính xác thì lui về mục cùng thư mục',
  );
  assert.equal(store.lookup('https://elsewhere.test/dl/x.iso'), null);
});

test('HeaderStore quên theo TTL và đuổi mục cũ nhất khi đầy', () => {
  let clock = 0;
  const store = new HeaderStore({ now: () => clock, ttlMs: 10_000, maxEntries: 2 });

  // Ba origin khác nhau để phép lui về "cùng thư mục" không che mất việc bị đuổi.
  store.remember('https://a.test/f', emptyCapture(0));
  store.remember('https://b.test/f', emptyCapture(0));
  store.remember('https://c.test/f', emptyCapture(0));
  assert.equal(store.size, 2, 'vượt trần thì mục cũ nhất bị đuổi');
  assert.equal(store.lookup('https://a.test/f'), null);

  clock = 10_000;
  assert.equal(store.prune(), 2);
  assert.equal(store.size, 0, 'cookie không được nằm lại trong RAM lâu hơn cần thiết');
});

test('captureFromDownloadItem lấy được Referer mà không cần thêm quyền nào', () => {
  const cap = captureFromDownloadItem(
    { url: 'https://cdn.test/f.iso', referrer: 'https://site.test/page?x=1' },
    'Mozilla/5.0 (test)',
    123,
  );
  assert.equal(cap.referer, 'https://site.test/page?x=1');
  assert.equal(cap.origin, 'https://site.test');
  assert.equal(cap.capturedFrom, 'https://site.test');
  assert.equal(cap.userAgent, 'Mozilla/5.0 (test)');
  assert.equal(cap.capturedAt, 123);

  const bare = captureFromDownloadItem({ url: 'https://cdn.test/f.iso' }, null, 0);
  assert.equal(bare.referer, null);
  assert.equal(bare.capturedFrom, 'https://cdn.test');
});

test('captureFromRequestHeaders vứt ngay những header không bao giờ phát lại được', () => {
  const cap = captureFromRequestHeaders(
    [
      { name: 'Referer', value: 'https://site.test/page' },
      { name: 'Cookie', value: 'session=bimat' },
      { name: 'User-Agent', value: 'Mozilla/5.0' },
      { name: 'Authorization', value: 'Bearer xyz' },
      { name: 'Host', value: 'site.test' },
      { name: 'Sec-Fetch-Mode', value: 'cors' },
      { name: 'Range', value: 'bytes=0-' },
    ],
    'https://site.test/page',
    5,
  );

  assert.equal(cap.referer, 'https://site.test/page');
  assert.equal(cap.cookie, 'session=bimat');
  assert.equal(cap.extra['authorization'], 'Bearer xyz');
  assert.equal(cap.extra['host'], undefined);
  assert.equal(cap.extra['sec-fetch-mode'], undefined);
  assert.equal(cap.extra['range'], undefined);
  assert.equal(cap.capturedFrom, 'https://site.test');
});

test('redact che Cookie và Authorization trước khi log', () => {
  const cap = emptyCapture(0);
  cap.cookie = 'session=bimat';
  cap.extra['authorization'] = 'Bearer bimat';
  cap.extra['x-trace'] = 'khong-bi-mat';

  const out = redact(cap);
  assert.ok(!JSON.stringify(out).includes('bimat'), 'không một mẩu bí mật nào được lọt ra log');
  assert.equal(out['extra.x-trace'], 'khong-bi-mat');
});

/* ==================================================================
 * Streaming — server không nói kích thước
 * ================================================================== */

// Kiểu trả về ghi rõ <ArrayBuffer> chứ không để mặc định: `Uint8Array` trần là
// `Uint8Array<ArrayBufferLike>`, mà ArrayBufferLike gồm cả SharedArrayBuffer nên
// không lọt qua được BodyInit khi dựng `new Response(...)`.
function chunk(byte: number, size: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array(size).fill(byte);
}

function streamOf(chunks: Uint8Array[], failAfter: number | null = null): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (failAfter !== null && i >= failAfter) {
        controller.error(new Error('kết nối đứt giữa chừng'));
        return;
      }
      const next = chunks[i];
      if (!next) {
        controller.close();
        return;
      }
      i += 1;
      controller.enqueue(next);
    },
  });
}

/**
 * Trả trọn `count` chunk rồi mới báo lỗi ở lần pull KẾ TIẾP.
 *
 * Khác `streamOf(..., failAfter)` ở một điểm quan trọng: gọi `controller.error()`
 * ngay trong cùng lần pull vừa enqueue sẽ làm chunk đó bị vứt, và test tưởng là
 * đang kiểm tra đường nối lại thì thật ra vẫn đang chạy đường tải mới.
 */
function deliverThenBreak(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks[i];
      if (!next) {
        controller.error(new Error('kết nối đứt giữa chừng'));
        return;
      }
      i += 1;
      controller.enqueue(next);
    },
  });
}

function recordingSink(): StreamSink & { writes: Array<{ offset: number; bytes: number }> } {
  const writes: Array<{ offset: number; bytes: number }> = [];
  return {
    writes,
    async write(offset, data) {
      writes.push({ offset, bytes: data.byteLength });
    },
  };
}

/** Watchdog tắt hẳn để test không phụ thuộc đồng hồ thật. */
const NO_IDLE = { ...DEFAULT_STREAM, idleTimeoutMs: 0 };
const noSleep = async (): Promise<void> => {};

test('streaming: ghi tuần tự đúng offset rồi kết thúc bằng EOF sạch', async () => {
  const sink = recordingSink();
  const stream = new StreamDownload(
    { url: 'https://x.test/chunked' },
    sink,
    NO_IDLE,
    {
      fetch: async () =>
        new Response(streamOf([chunk(1, 10), chunk(2, 20), chunk(3, 5)]), {
          status: 200,
          headers: { 'content-type': 'application/zip' },
        }),
      sleep: noSleep,
    },
  );

  const out = await stream.run();
  assert.equal(out.ending, 'eof');
  assert.equal(out.completed, true);
  assert.equal(out.totalBytes, 35);
  assert.deepEqual(
    sink.writes.map((w) => w.offset),
    [0, 10, 30],
  );
  assert.equal(stream.info.mimeType, 'application/zip');
});

test('streaming: đứt giữa chừng thì nối lại bằng Range đúng chỗ', async () => {
  const sink = recordingSink();
  const seen: Array<string | null> = [];

  const stream = new StreamDownload(
    { url: 'https://x.test/chunked' },
    sink,
    { ...NO_IDLE, backoffMs: 0 },
    {
      sleep: noSleep,
      fetch: async (_input, init) => {
        const headers = new Headers(init?.headers ?? {});
        seen.push(headers.get('Range'));
        if (seen.length === 1) {
          return new Response(streamOf([chunk(1, 10)], 1), { status: 200 });
        }
        return new Response(streamOf([chunk(2, 6)]), {
          status: 206,
          headers: { 'content-range': 'bytes 10-15/16' },
        });
      },
    },
  );

  const out = await stream.run();
  assert.equal(out.ending, 'eof');
  assert.equal(out.totalBytes, 16);
  assert.equal(out.attempts, 2);
  assert.deepEqual(seen, [null, 'bytes=10-']);
  assert.deepEqual(
    sink.writes.map((w) => w.offset),
    [0, 10],
  );
  assert.equal(stream.info.totalSize, 16, 'lần nối lại cho biết luôn tổng kích thước');
});

test('streaming: server phớt lờ Range và trả 200 thì KHÔNG ghi đè lệch', async () => {
  const sink = recordingSink();
  const stream = new StreamDownload(
    { url: 'https://x.test/chunked' },
    sink,
    { ...NO_IDLE, backoffMs: 0 },
    {
      sleep: noSleep,
      fetch: (() => {
        let call = 0;
        return async () => {
          call += 1;
          if (call === 1) return new Response(streamOf([chunk(1, 10)], 1), { status: 200 });
          // Xin bytes=10- nhưng nhận nguyên file từ đầu.
          return new Response(streamOf([chunk(9, 30)]), { status: 200 });
        };
      })(),
    },
  );

  const out = await stream.run();
  assert.equal(out.ending, 'restart-needed');
  assert.equal(out.completed, false);
  assert.deepEqual(sink.writes.map((w) => w.offset), [0], 'không được ghi thêm byte nào');
  assert.match(out.error ?? '', /phớt lờ Range/);
});

test('streaming: nội dung nén trên đường truyền thì tuyệt đối không nối lại', async () => {
  const sink = recordingSink();
  let calls = 0;

  const stream = new StreamDownload(
    { url: 'https://x.test/chunked' },
    sink,
    { ...NO_IDLE, backoffMs: 0 },
    {
      sleep: noSleep,
      fetch: async () => {
        calls += 1;
        return new Response(streamOf([chunk(1, 10)], 1), {
          status: 200,
          headers: { 'content-encoding': 'gzip' },
        });
      },
    },
  );

  const out = await stream.run();
  assert.equal(stream.info.transportCompressed, true);
  assert.equal(out.ending, 'restart-needed');
  assert.equal(calls, 1, 'thử lại sẽ ghi lệch offset và tạo ra file hỏng lặng lẽ');
  assert.equal(stream.info.acceptRanges, false);
});

test('streaming: maxBytes là phanh tay cho stream không biết kích thước', async () => {
  const sink = recordingSink();
  const stream = new StreamDownload(
    { url: 'https://x.test/infinite' },
    sink,
    { ...NO_IDLE, maxBytes: 25 },
    {
      sleep: noSleep,
      fetch: async () => new Response(streamOf([chunk(1, 20), chunk(2, 20), chunk(3, 20)])),
    },
  );

  const out = await stream.run();
  assert.equal(out.ending, 'limit');
  assert.equal(out.totalBytes, 25);
});

test('streaming: kết nối im lặng quá lâu thì bị cắt và tính là một lần thử', async () => {
  let clock = 0;
  const sink = recordingSink();

  const stream = new StreamDownload(
    { url: 'https://x.test/hang' },
    sink,
    { ...DEFAULT_STREAM, idleTimeoutMs: 1000, maxAttempts: 1 },
    {
      now: () => clock,
      sleep: async (ms: number) => {
        clock += ms;
      },
      // Body không bao giờ trả byte nào: đúng kiểu treo mà fetch không tự phát hiện.
      fetch: async () => new Response(new ReadableStream<Uint8Array>({ pull() {} })),
    },
  );

  const out = await stream.run();
  assert.equal(out.ending, 'error');
  assert.equal(out.attempts, 1);
  assert.match(out.error ?? '', /không nhận được byte nào/);
});

test('streaming: lỗi 404 không đáng thử lại', async () => {
  const stream = new StreamDownload(
    { url: 'https://x.test/gone' },
    recordingSink(),
    NO_IDLE,
    { sleep: noSleep, fetch: async () => new Response('', { status: 404, statusText: 'Not Found' }) },
  );

  const out = await stream.run();
  assert.equal(out.ending, 'error');
  assert.equal(out.attempts, 1);
  assert.match(out.error ?? '', /404/);
});

test('streaming: nối lại mà phản hồi bị nén thì KHÔNG được ghi tiếp', async () => {
  const sink = recordingSink();
  let calls = 0;

  const stream = new StreamDownload(
    { url: 'https://x.test/f' },
    sink,
    { ...NO_IDLE, backoffMs: 0 },
    {
      sleep: noSleep,
      fetch: async () => {
        calls += 1;
        // Lần đầu sạch sẽ, đứt sau 10 byte. Lần nối lại server bật nén: byte trả
        // về đã được fetch giải nén, còn Range của server đếm trên byte NÉN.
        if (calls === 1) return new Response(deliverThenBreak([chunk(1, 10)]), { status: 200 });
        return new Response(chunk(9, 50), {
          status: 206,
          headers: { 'content-range': 'bytes 10-59/60', 'content-encoding': 'gzip' },
        });
      },
    },
  );

  const out = await stream.run();
  assert.equal(out.ending, 'restart-needed');
  assert.equal(out.completed, false, 'tuyệt đối không được báo hoàn tất');
  assert.deepEqual(
    sink.writes.map((w) => w.offset),
    [0],
    'ghi byte đã giải nén vào offset của luồng nén là file hỏng lặng lẽ',
  );
});

test('streaming: 416 lúc nối lại đúng cuối file nghĩa là đã xong, không phải lỗi', async () => {
  const sink = recordingSink();
  let calls = 0;

  const stream = new StreamDownload(
    { url: 'https://x.test/f' },
    sink,
    { ...NO_IDLE, backoffMs: 0 },
    {
      sleep: noSleep,
      fetch: async () => {
        calls += 1;
        if (calls === 1) return new Response(deliverThenBreak([chunk(1, 10)]), { status: 200 });
        // Xin bytes=10- trong khi file chỉ dài đúng 10 byte.
        return new Response('', {
          status: 416,
          statusText: 'Range Not Satisfiable',
          headers: { 'content-range': 'bytes */10' },
        });
      },
    },
  );

  const out = await stream.run();
  assert.equal(out.ending, 'eof', 'kết nối đứt đúng lúc byte cuối vừa tới');
  assert.equal(out.completed, true);
  assert.equal(out.totalBytes, 10);
});

test('streaming: 416 mà file dài hơn chỗ ta có thì tải lại chứ không nhận bừa', async () => {
  const sink = recordingSink();
  let calls = 0;

  const stream = new StreamDownload(
    { url: 'https://x.test/f' },
    sink,
    { ...NO_IDLE, backoffMs: 0 },
    {
      sleep: noSleep,
      fetch: async () => {
        calls += 1;
        if (calls === 1) return new Response(deliverThenBreak([chunk(1, 10)]), { status: 200 });
        return new Response('', {
          status: 416,
          statusText: 'Range Not Satisfiable',
          headers: { 'content-range': 'bytes */999' },
        });
      },
    },
  );

  const out = await stream.run();
  assert.equal(out.ending, 'restart-needed');
  assert.equal(out.completed, false, 'thiếu 989 byte mà báo xong là giao file hỏng');
});

test('streaming: pause dừng hẳn việc ghi, resume mở lại từ đúng offset', async () => {
  const sink = recordingSink();
  const ranges: Array<string | null> = [];

  // Nguồn đẩy tay từng chunk một, không dùng đồng hồ thật, nên test tất định.
  // Trả false khi stream đã bị đóng, tức là kết nối thật sự đã được buông.
  // Giữ hàm đẩy trong một ô chứa chứ không trong một biến trần: TypeScript không
  // thấy được callback `start` đã chạy nên sẽ thu hẹp biến trần xuống `null`.
  const pusher: { send: ((data: Uint8Array) => boolean) | null } = { send: null };
  const openStream = (): ReadableStream<Uint8Array> =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        pusher.send = (data) => {
          try {
            controller.enqueue(data);
            return true;
          } catch {
            return false;
          }
        };
      },
    });

  const stream = new StreamDownload(
    { url: 'https://x.test/f' },
    sink,
    { ...NO_IDLE, backoffMs: 0 },
    {
      sleep: noSleep,
      fetch: async (_input, init) => {
        ranges.push(new Headers(init?.headers ?? {}).get('Range'));
        const status = ranges.length === 1 ? 200 : 206;
        const headers = status === 206 ? { 'content-range': 'bytes 4-11/12' } : undefined;
        return new Response(openStream(), { status, headers });
      },
    },
  );

  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  const running = stream.run();
  await settle();
  pusher.send?.(chunk(1, 4));
  await settle();
  assert.equal(stream.offset, 4);

  stream.pause();
  await settle();
  const frozen = stream.offset;
  // Đẩy tiếp trong lúc đang tạm dừng. Tạm dừng phải buông hẳn kết nối, nên lời
  // đẩy này bị stream đã đóng từ chối — và tuyệt đối không byte nào được ghi thêm.
  assert.equal(pusher.send?.(chunk(2, 4)), false, 'tạm dừng mà vẫn giữ socket là rò tài nguyên');
  await settle();
  assert.equal(stream.offset, frozen, 'tạm dừng rồi mà vẫn ghi thì offset sẽ lệch');

  stream.resume();
  await settle();
  pusher.send?.(chunk(3, 8));
  await settle();

  stream.abort();
  const out = await running;

  assert.equal(out.ending, 'aborted');
  assert.deepEqual(ranges, [null, 'bytes=4-'], 'mở lại phải xin đúng chỗ đang dở');
  assert.deepEqual(
    sink.writes.map((w) => w.offset),
    [0, 4],
    'không được có lỗ hổng lẫn ghi đè giữa hai lần nối',
  );
});

test('streaming: abort trả kết quả ngay cả khi body chưa bao giờ trả byte nào', async () => {
  const stream = new StreamDownload(
    { url: 'https://x.test/hang' },
    recordingSink(),
    NO_IDLE,
    {
      sleep: noSleep,
      fetch: async () => new Response(new ReadableStream<Uint8Array>({ pull() {} })),
    },
  );

  const running = stream.run();
  await new Promise((resolve) => setTimeout(resolve, 0));
  stream.abort();

  const out = await running;
  assert.equal(out.ending, 'aborted', 'chỉ chờ read() thì abort sẽ treo vĩnh viễn');
  assert.equal(out.totalBytes, 0);
});

test('streaming: hủy trong lúc chờ backoff phải có hiệu lực ngay', async () => {
  // Backoff lên tới 30 giây. Nếu abort() không đánh thức được nó thì writer OPFS
  // — đang khóa độc quyền file tạm — bị giữ thêm chừng ấy thời gian vô ích.
  let slept = 0;
  const stream = new StreamDownload(
    { url: 'https://x.test/f' },
    recordingSink(),
    { ...NO_IDLE, backoffMs: 30_000, maxAttempts: 5 },
    {
      // Giấc ngủ này CỐ Ý không bao giờ tự kết thúc: chỉ abort() mới gỡ ra được.
      sleep: () => {
        slept += 1;
        return new Promise<void>(() => {});
      },
      fetch: async () => new Response(streamOf([chunk(1, 4)], 1), { status: 200 }),
    },
  );

  const running = stream.run();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(slept, 1, 'phải đang nằm chờ backoff');

  stream.abort();
  const out = await running;
  assert.equal(out.ending, 'aborted');
  assert.equal(out.totalBytes, 4);
});

test('parseUnsatisfiedTotal chỉ nhận đúng dạng Content-Range của 416', () => {
  assert.equal(parseUnsatisfiedTotal('bytes */5000'), 5000);
  assert.equal(parseUnsatisfiedTotal('  bytes */0 '), 0);
  assert.equal(parseUnsatisfiedTotal('bytes 0-99/5000'), null, 'đó là dạng của 206');
  assert.equal(parseUnsatisfiedTotal('bytes */*'), null);
  assert.equal(parseUnsatisfiedTotal(null), null);
});

test('parseContentRange đọc được cả dạng có tổng lẫn dạng sao', () => {
  assert.deepEqual(parseContentRange('bytes 100-199/5000'), { start: 100, end: 199, total: 5000 });
  assert.deepEqual(parseContentRange('bytes 0-0/*'), { start: 0, end: 0, total: null });
  assert.equal(parseContentRange('bytes */5000'), null);
  assert.equal(parseContentRange(null), null);
  assert.equal(parseContentRange('linh tinh'), null);
});

test('discoverTotalSize lấy được tổng kích thước bằng suffix range', async () => {
  let seen: string | null = null;
  const res = await discoverTotalSize(
    'https://x.test/f.iso',
    {},
    async (_input, init) => {
      seen = new Headers(init?.headers ?? {}).get('Range');
      return new Response(new Uint8Array(1), {
        status: 206,
        headers: { 'content-range': 'bytes 4095-4095/4096' },
      });
    },
  );

  assert.equal(seen, 'bytes=-1', 'probe.ts chỉ thử bytes=0-0, đây là mũi thứ hai');
  assert.equal(res.total, 4096);
  assert.equal(res.acceptRanges, true);
});

test('discoverTotalSize không tin Content-Length khi nội dung bị nén', async () => {
  const res = await discoverTotalSize(
    'https://x.test/f.iso',
    {},
    async () =>
      new Response('x', {
        status: 200,
        headers: { 'content-length': '999', 'content-encoding': 'gzip' },
      }),
  );
  assert.equal(res.total, null, '999 là kích thước đã nén, vô dụng với ta');
});

test('createPortSink chặn lại khi vượt ngưỡng và mở van khi có biên nhận', async () => {
  const channel = new MessageChannel();
  const port1 = channel.port1 as unknown as MessagePort;
  const port2 = channel.port2 as unknown as MessagePort;

  const sink = createPortSink(port1, 8);
  const delivered = new Promise<number>((resolve) => {
    port2.onmessage = (event: MessageEvent) => {
      resolve((event.data as { offset: number }).offset);
    };
  });

  try {
    let released = false;
    const pending = sink.write(0, new Uint8Array(8)).then(() => {
      released = true;
    });

    assert.equal(await delivered, 0, 'buffer vẫn được đẩy sang writer ngay');
    assert.equal(released, false, 'chạm ngưỡng thì phải chặn lại, nếu không RAM sẽ phình');

    port2.postMessage({ written: 8 });
    await pending;
    assert.equal(released, true);
  } finally {
    sink.dispose();
    channel.port1.close();
    channel.port2.close();
  }
});
