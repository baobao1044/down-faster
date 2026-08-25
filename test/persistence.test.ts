import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_PERSISTENCE_OPTIONS,
  RECORD_PREFIX,
  SCHEMA_VERSION,
  TaskPersistence,
  decodePieces,
  decodeRecord,
  encodePieces,
  encodeTask,
  migrateRecord,
  recordKey,
  selectStale,
  storeFromArea,
  taskIdFromKey,
  type PersistableTask,
  type PersistedTask,
  type PersistenceStore,
} from '../src/engine/persistence';
import {
  RESUME_REWIND_BYTES,
  compareValidators,
  isWeakValidator,
  planRecovery,
  rebuildPieces,
  reconcile,
  verifyAgainstProbe,
  type PartInspector,
  type RecoverySource,
} from '../src/engine/recovery';
import type { Piece, ProbeResult } from '../src/engine/types';

/**
 * Chốt một giá trị có thể null rồi trả về nó đã thu hẹp kiểu. Repo không cài
 * @types/node nên `assert.ok()` không đóng vai trò assertion function được.
 */
function must<T>(value: T | null, message: string): T {
  assert.notEqual(value, null, message);
  return value as T;
}

const MB = 1024 * 1024;
const PIECE = 4 * MB;
const SIZE = 10 * MB; // 3 piece: 4MB, 4MB, 2MB — piece cuối cố tình ngắn hơn.

/* ---------- Tiện ích ---------- */

interface MemoryStore extends PersistenceStore {
  data: Map<string, unknown>;
  writes: number;
  removed: string[];
}

/** Store trong RAM: không cần giả lập chrome, và mô phỏng luôn ranh giới clone. */
function memoryStore(seed: Record<string, unknown> = {}): MemoryStore {
  const data = new Map<string, unknown>(Object.entries(seed));
  const store: MemoryStore = {
    data,
    writes: 0,
    removed: [],
    async read(prefix) {
      const out: Record<string, unknown> = {};
      for (const [key, value] of data) {
        if (key.startsWith(prefix)) out[key] = structuredClone(value);
      }
      return out;
    },
    async write(entries) {
      store.writes += 1;
      for (const [key, value] of Object.entries(entries)) data.set(key, structuredClone(value));
    },
    async remove(keys) {
      for (const key of keys) {
        store.removed.push(key);
        data.delete(key);
      }
    },
  };
  return store;
}

function manualClock(start = 1_000_000): { now(): number; advance(ms: number): void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

interface ManualScheduler {
  schedule(fn: () => void, ms: number): () => void;
  runDue(): void;
  pending(): number;
}

function manualScheduler(): ManualScheduler {
  const jobs: Array<{ fn: () => void; canceled: boolean }> = [];
  return {
    schedule(fn) {
      const job = { fn, canceled: false };
      jobs.push(job);
      return () => {
        job.canceled = true;
      };
    },
    runDue() {
      for (const job of jobs.splice(0, jobs.length)) {
        if (!job.canceled) job.fn();
      }
    },
    pending() {
      return jobs.filter((j) => !j.canceled).length;
    },
  };
}

function makePieces(received: readonly number[] = [PIECE, 0, 0]): Piece[] {
  const bounds: Array<[number, number]> = [
    [0, PIECE - 1],
    [PIECE, 2 * PIECE - 1],
    [2 * PIECE, SIZE - 1],
  ];
  return bounds.map(([start, end], i) => {
    const got = received[i] ?? 0;
    return {
      index: i,
      start,
      end,
      received: got,
      state: got === end - start + 1 ? 'done' : 'pending',
      attempts: 0,
    } satisfies Piece;
  });
}

function makeTask(over: Partial<PersistableTask> = {}): PersistableTask {
  const pieces = makePieces();
  return {
    id: 'task-1',
    source: 'manual',
    url: 'https://x.test/big.iso',
    finalUrl: 'https://cdn.test/big.iso',
    filename: 'big.iso',
    size: SIZE,
    state: 'downloading',
    received: PIECE,
    pieces,
    error: null,
    createdAt: 1_000,
    speed: 0,
    acceptRanges: true,
    etag: '"abc123"',
    lastModified: null,
    mimeType: 'application/octet-stream',
    ...over,
  };
}

function makeRecord(over: Partial<PersistedTask> = {}): PersistedTask {
  return {
    version: SCHEMA_VERSION,
    id: 'task-1',
    source: 'manual',
    url: 'https://x.test/big.iso',
    finalUrl: 'https://cdn.test/big.iso',
    filename: 'big.iso',
    mimeType: 'application/octet-stream',
    size: SIZE,
    acceptRanges: true,
    etag: '"abc123"',
    lastModified: null,
    state: 'downloading',
    received: PIECE,
    pieces: { pieceSize: PIECE, count: 3, received: [PIECE, 0, 0] },
    createdAt: 1_000,
    updatedAt: 2_000,
    ...over,
  };
}

function makeProbe(over: Partial<ProbeResult> = {}): ProbeResult {
  return {
    finalUrl: 'https://cdn.test/big.iso',
    size: SIZE,
    acceptRanges: true,
    filename: 'big.iso',
    mimeType: 'application/octet-stream',
    etag: '"abc123"',
    lastModified: null,
    ...over,
  };
}

/** Đẩy tiến độ vào piece giữa, giữ task.received nhất quán với bản đồ piece. */
function advanceProgress(task: PersistableTask, bytes: number): void {
  const piece = task.pieces[1]!;
  const length = piece.end - piece.start + 1;
  piece.received = Math.min(length, piece.received + bytes);
  if (piece.received === length) piece.state = 'done';
  task.received = task.pieces.reduce((sum, p) => sum + p.received, 0);
}

/* ---------- 1. Phiên bản schema ---------- */

test('bản ghi đúng phiên bản đi trọn vòng encode/decode mà không mất mát', () => {
  const encoded = must(encodeTask(makeTask(), 5_000), 'encodeTask phải lưu được task đang tải');
  const decoded = decodeRecord(structuredClone(encoded));
  assert.deepEqual(decoded, encoded);
  assert.equal(encoded.createdAt, 1_000, 'createdAt phải giữ nguyên từ phiên trước');
  assert.equal(encoded.updatedAt, 5_000);
});

test('bản ghi do phiên bản mới hơn ghi ra bị từ chối thay vì đọc bừa', () => {
  assert.equal(migrateRecord(makeRecord({ version: SCHEMA_VERSION + 1 })), null);
});

test('bản ghi của schema cũ hơn cũng bị từ chối khi chưa có đường nâng cấp', () => {
  assert.equal(migrateRecord(makeRecord({ version: 0 })), null);
  assert.equal(decodeRecord(makeRecord({ version: 0 })), null);
});

test('thiếu trường version thì không phải bản ghi của ta', () => {
  const { version: _drop, ...withoutVersion } = makeRecord();
  assert.equal(migrateRecord(withoutVersion), null);
  assert.equal(migrateRecord(null), null);
  assert.equal(migrateRecord('df:task:x'), null);
  assert.equal(migrateRecord([]), null);
});

test('khóa của tính năng khác không bị nhận nhầm là bản ghi task', () => {
  assert.equal(taskIdFromKey('settings'), null);
  assert.equal(taskIdFromKey('df:other:1'), null);
  assert.equal(taskIdFromKey(RECORD_PREFIX), null);
  assert.equal(taskIdFromKey(recordKey('abc')), 'abc');
});

test('url không phải http/https bị loại, nếu không engine sẽ tự đi đọc file cục bộ', () => {
  assert.equal(decodeRecord(makeRecord({ url: 'file:///etc/passwd' })), null);
  assert.equal(decodeRecord(makeRecord({ url: 'javascript:alert(1)' })), null);
  assert.equal(decodeRecord(makeRecord({ url: 'not a url' })), null);
});

test('finalUrl hỏng chỉ bị thay bằng url gốc chứ không làm mất cả bản ghi', () => {
  const decoded = must(
    decodeRecord(makeRecord({ finalUrl: 'file:///tmp/x' })),
    'finalUrl hỏng không được làm mất cả bản ghi',
  );
  assert.equal(decoded.finalUrl, 'https://x.test/big.iso');
});

test('tên file được sanitize lại nên không thoát được thư mục tải', () => {
  const decoded = must(
    decodeRecord(makeRecord({ filename: '../../autostart.desktop' })),
    'tên file xấu chỉ bị làm sạch chứ không loại bản ghi',
  );
  assert.equal(decoded.filename, 'autostart.desktop');
});

test('received vượt độ dài piece thì loại cả bản ghi, không kẹp im lặng', () => {
  const bad = makeRecord({
    pieces: { pieceSize: PIECE, count: 3, received: [PIECE + 1, 0, 0] },
  });
  assert.equal(decodeRecord(bad), null);
});

test('bản đồ piece không khớp kích thước file thì bị loại', () => {
  const bad = makeRecord({ pieces: { pieceSize: PIECE, count: 9, received: new Array(9).fill(0) } });
  assert.equal(decodeRecord(bad), null);
});

test('etag chứa ký tự điều khiển bị bỏ, không mang xuống làm header', () => {
  const dirty = makeRecord({ etag: `"abc${String.fromCharCode(10)}def"` });
  const decoded = must(decodeRecord(dirty), 'bản ghi vẫn dùng được sau khi bỏ etag bẩn');
  assert.equal(decoded.etag, null);
});

/* ---------- 2. Bản đồ piece ---------- */

test('bố cục đều được nén thành pieceSize + count, không mang theo starts', () => {
  const map = encodePieces(makePieces([PIECE, 1024, 0]));
  assert.deepEqual(map, { pieceSize: PIECE, count: 3, received: [PIECE, 1024, 0] });
});

test('decode dựng lại đúng bố cục đều, kể cả piece cuối ngắn hơn', () => {
  const original = makePieces([PIECE, 1024, 0]);
  const map = must(encodePieces(original), 'bố cục đều phải nén được');
  const rebuilt = must(decodePieces(map, SIZE), 'bản đồ vừa nén phải dựng lại được');
  assert.equal(rebuilt.length, 3);
  assert.deepEqual(
    rebuilt.map((p) => [p.start, p.end]),
    original.map((p) => [p.start, p.end]),
  );
  assert.equal(rebuilt[2]!.end - rebuilt[2]!.start + 1, 2 * MB);
});

test('bố cục không đều rơi xuống nhánh starts và vẫn phủ kín file', () => {
  const uneven: Piece[] = [
    { index: 0, start: 0, end: MB - 1, received: MB, state: 'done', attempts: 0 },
    { index: 1, start: MB, end: 5 * MB - 1, received: 0, state: 'pending', attempts: 0 },
    { index: 2, start: 5 * MB, end: SIZE - 1, received: 0, state: 'pending', attempts: 0 },
  ];
  const map = must(encodePieces(uneven), 'bố cục không đều vẫn phải lưu được');
  assert.equal(map.pieceSize, 0);
  assert.deepEqual(map.starts, [0, MB, 5 * MB]);

  const rebuilt = must(decodePieces(map, SIZE), 'nhánh starts phải dựng lại được');
  const covered = rebuilt.reduce((sum, p) => sum + (p.end - p.start + 1), 0);
  assert.equal(covered, SIZE);
});

test('piece dựng lại nối liền nhau, không hở và không chồng lấn', () => {
  const map = must(encodePieces(makePieces()), 'bản đồ phải nén được');
  const rebuilt = must(decodePieces(map, SIZE), 'bản đồ phải dựng lại được');
  assert.equal(rebuilt[0]!.start, 0);
  assert.equal(rebuilt.at(-1)!.end, SIZE - 1);
  for (let i = 1; i < rebuilt.length; i++) {
    assert.equal(rebuilt[i]!.start, rebuilt[i - 1]!.end + 1, `piece ${i} không nối liền`);
  }
});

test('bản đồ có lỗ hổng giữa các piece thì không đáng lưu', () => {
  const gapped = makePieces();
  gapped[1]!.start += 4096; // Tạo một lỗ ngay sau piece đầu.
  assert.equal(encodePieces(gapped), null);
  assert.equal(encodePieces([]), null);
});

test('piece đã đầy giữ trạng thái done, piece dở lùi đúng biên an toàn', () => {
  const record = makeRecord({
    pieces: { pieceSize: PIECE, count: 3, received: [PIECE, 3 * MB, 0] },
  });
  const rebuilt = must(rebuildPieces(record), 'bản ghi hợp lệ phải dựng lại được piece');
  assert.equal(rebuilt[0]!.state, 'done');
  assert.equal(rebuilt[0]!.received, PIECE);
  assert.equal(rebuilt[1]!.state, 'pending');
  assert.equal(rebuilt[1]!.received, 3 * MB - RESUME_REWIND_BYTES);
  assert.equal(rebuilt[1]!.attempts, 0, 'phiên mới xứng đáng có lại đủ lượt thử');
});

test('lùi biên an toàn không bao giờ cho received âm', () => {
  const record = makeRecord({ pieces: { pieceSize: PIECE, count: 3, received: [0, 4096, 0] } });
  const rebuilt = must(rebuildPieces(record), 'bản ghi hợp lệ phải dựng lại được piece');
  assert.equal(rebuilt[1]!.received, 0);
});

/* ---------- 3. Phát hiện file trên server đã đổi ---------- */

const stored = { etag: '"abc"', lastModified: null, size: SIZE };

test('ETag mạnh giống nhau và kích thước khớp thì nối tiếp được', () => {
  assert.equal(compareValidators(stored, { etag: '"abc"', lastModified: null, size: SIZE }), 'same');
});

test('ETag mạnh khác nhau nghĩa là file đã đổi', () => {
  assert.equal(
    compareValidators(stored, { etag: '"xyz"', lastModified: null, size: SIZE }),
    'changed',
  );
});

test('ETag yếu không dùng được cho If-Range, dù hai bên giống hệt nhau', () => {
  assert.equal(isWeakValidator('W/"abc"'), true);
  assert.equal(isWeakValidator('"abc"'), false);
  assert.equal(isWeakValidator(null), false);
  assert.equal(
    compareValidators(
      { etag: 'W/"abc"', lastModified: null, size: SIZE },
      { etag: 'W/"abc"', lastModified: null, size: SIZE },
    ),
    'unverifiable',
  );
});

test('server ngừng gửi ETag thì không còn gì để đối chiếu', () => {
  assert.equal(
    compareValidators(stored, { etag: null, lastModified: null, size: SIZE }),
    'unverifiable',
  );
});

test('chỉ có Last-Modified và giống nhau, kích thước khớp thì vẫn nối tiếp được', () => {
  const only = { etag: null, lastModified: 'Wed, 21 Oct 2015 07:28:00 GMT', size: SIZE };
  assert.equal(compareValidators(only, { ...only }), 'same');
});

test('Last-Modified khác nghĩa là file đã đổi', () => {
  const only = { etag: null, lastModified: 'Wed, 21 Oct 2015 07:28:00 GMT', size: SIZE };
  assert.equal(
    compareValidators(only, { ...only, lastModified: 'Thu, 22 Oct 2015 07:28:00 GMT' }),
    'changed',
  );
});

test('không bên nào có validator thì coi như không xác minh được', () => {
  assert.equal(
    compareValidators(
      { etag: null, lastModified: null, size: SIZE },
      { etag: null, lastModified: null, size: SIZE },
    ),
    'unverifiable',
  );
});

test('kích thước khác thì file đã đổi, bất kể ETag nói gì', () => {
  assert.equal(
    compareValidators(stored, { etag: '"abc"', lastModified: null, size: SIZE + 1 }),
    'changed',
  );
});

test('verifyAgainstProbe từ chối khi server thôi hỗ trợ Range', () => {
  const result = verifyAgainstProbe(makeRecord(), makeProbe({ acceptRanges: false }));
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.reason : '', /khoảng byte/);
});

test('verifyAgainstProbe từ chối khi server không cho biết kích thước', () => {
  const result = verifyAgainstProbe(makeRecord(), makeProbe({ size: null }));
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.reason : '', /kích thước/);
});

test('verifyAgainstProbe chấp nhận khi ETag mạnh còn nguyên', () => {
  assert.deepEqual(verifyAgainstProbe(makeRecord(), makeProbe()), { ok: true });
});

test('verifyAgainstProbe bỏ qua chuyện finalUrl đã đổi, vì CDN xoay node liên tục', () => {
  const probe = makeProbe({ finalUrl: 'https://cdn-2.test/other-node/big.iso' });
  assert.deepEqual(verifyAgainstProbe(makeRecord(), probe), { ok: true });
});

test('verifyAgainstProbe từ chối khi ETag đã đổi', () => {
  const result = verifyAgainstProbe(makeRecord(), makeProbe({ etag: '"moi-tinh"' }));
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.reason : '', /đã thay đổi/);
});

/* ---------- 4. Đối chiếu với file .part ---------- */

test('không còn file tạm thì bản ghi là mồ côi, vứt bỏ', () => {
  const verdict = reconcile(makeRecord(), { exists: false, size: 0 });
  assert.equal(verdict.action, 'discard');
});

test('file tạm dài khác bản ghi thì phải tải lại từ đầu', () => {
  const verdict = reconcile(makeRecord(), { exists: true, size: SIZE - 4096 });
  assert.equal(verdict.action, 'restart');
});

test('file tạm đúng kích thước thì nối tiếp, và remaining tính đúng', () => {
  const record = makeRecord({
    pieces: { pieceSize: PIECE, count: 3, received: [PIECE, 3 * MB, 0] },
  });
  const verdict = reconcile(record, { exists: true, size: SIZE });
  assert.equal(verdict.action, 'resume');
  if (verdict.action !== 'resume') return;
  const kept = PIECE + (3 * MB - RESUME_REWIND_BYTES);
  assert.equal(verdict.remaining, SIZE - kept);
});

test('server không nhận Range thì không nối tiếp được, dù file tạm còn nguyên', () => {
  const verdict = reconcile(makeRecord({ acceptRanges: false }), { exists: true, size: SIZE });
  assert.equal(verdict.action, 'restart');
});

test('mọi piece đã xong thì vẫn resume, để đi thẳng tới bước ghép file', () => {
  const record = makeRecord({
    pieces: { pieceSize: PIECE, count: 3, received: [PIECE, PIECE, 2 * MB] },
  });
  const verdict = reconcile(record, { exists: true, size: SIZE });
  assert.equal(verdict.action, 'resume');
  if (verdict.action !== 'resume') return;
  assert.equal(verdict.remaining, 0);
  assert.ok(verdict.pieces.every((p) => p.state === 'done'));
});

test('planRecovery chỉ giữ file tạm của những lượt nối tiếp được', async () => {
  const forgotten: string[] = [];
  const source: RecoverySource = {
    async loadAll() {
      return {
        records: [
          makeRecord({ id: 'keep-me' }),
          makeRecord({ id: 'truncated' }),
          makeRecord({ id: 'gone' }),
        ],
        removedIds: ['corrupt'],
      };
    },
    async forget(id: string) {
      forgotten.push(id);
    },
  };
  const inspector: PartInspector = {
    async list() {
      return new Set(['keep-me', 'truncated']);
    },
    async size(id: string) {
      return id === 'keep-me' ? SIZE : 4096;
    },
    async remove() {},
  };

  const plan = await planRecovery(source, inspector);

  assert.deepEqual([...plan.keep], ['keep-me']);
  assert.equal(plan.resumable.length, 1);
  assert.equal(plan.resumable[0]!.seed.id, 'keep-me');
  assert.equal(plan.resumable[0]!.seed.pieces.length, 3);
  assert.equal(plan.resumable[0]!.seed.url, 'https://x.test/big.iso');
  assert.deepEqual(plan.restartable.map((r) => r.record.id), ['truncated']);
  assert.deepEqual(plan.discarded.map((d) => d.id).sort(), ['corrupt', 'gone']);
  // Bản ghi không còn mô tả đúng thứ gì trên đĩa thì phải biến mất khỏi storage.
  assert.deepEqual(forgotten.sort(), ['gone', 'truncated']);
});

/* ---------- 5. Nhịp ghi và dọn dẹp ---------- */

function makePersistence(over: Partial<{ intervalMs: number; bytesThreshold: number }> = {}): {
  store: MemoryStore;
  clock: ReturnType<typeof manualClock>;
  sched: ManualScheduler;
  persistence: TaskPersistence;
} {
  const store = memoryStore();
  const clock = manualClock();
  const sched = manualScheduler();
  const persistence = new TaskPersistence(store, over, {
    now: clock.now,
    schedule: sched.schedule,
  });
  return { store, clock, sched, persistence };
}

test('touch() liên tiếp trong cùng một nhịp chỉ sinh đúng một lần ghi', async () => {
  const { store, sched, persistence } = makePersistence();
  const task = makeTask();

  persistence.touch(task); // Task mới: ghi ngay để bản ghi tồn tại sớm nhất có thể.
  await persistence.settled();
  assert.equal(store.writes, 1);

  advanceProgress(task, 4096);
  persistence.touch(task);
  advanceProgress(task, 4096);
  persistence.touch(task);
  await persistence.settled();
  assert.equal(store.writes, 1, 'chưa tới nhịp thì không được ghi thêm');
  assert.equal(sched.pending(), 1, 'phải có đúng một hẹn giờ chốt sổ đang chờ');

  sched.runDue();
  await persistence.settled();
  assert.equal(store.writes, 2, 'hẹn giờ là lưới an toàn khi tiến độ ngừng chảy');
});

test('đủ intervalMs thì lần touch kế tiếp ghi ngay', async () => {
  const { store, clock, persistence } = makePersistence({ intervalMs: 4000 });
  const task = makeTask();

  persistence.touch(task);
  await persistence.settled();
  assert.equal(store.writes, 1);

  clock.advance(4000);
  advanceProgress(task, 4096);
  persistence.touch(task);
  await persistence.settled();
  assert.equal(store.writes, 2);
});

test('vượt ngưỡng byte thì ghi ngay dù chưa hết interval', async () => {
  const { store, clock, persistence } = makePersistence({
    intervalMs: 60_000,
    bytesThreshold: 2 * MB,
  });
  const task = makeTask();

  persistence.touch(task);
  await persistence.settled();
  assert.equal(store.writes, 1);

  clock.advance(10);
  advanceProgress(task, 2 * MB);
  persistence.touch(task);
  await persistence.settled();
  assert.equal(store.writes, 2, 'đường truyền nhanh không được mất nửa GB mỗi nhịp');
});

test('barrier xả đệm writer luôn chạy trước khi bản ghi được ghi', async () => {
  const order: string[] = [];
  const base = memoryStore();
  const store: PersistenceStore = {
    read: (prefix) => base.read(prefix),
    async write(entries) {
      order.push('write');
      await base.write(entries);
    },
    remove: (keys) => base.remove(keys),
  };
  const persistence = new TaskPersistence(
    store,
    {},
    {
      barrier: async (ids) => {
        order.push(`barrier:${ids.join(',')}`);
      },
    },
  );

  await persistence.checkpoint(makeTask());
  assert.deepEqual(order, ['barrier:task-1', 'write']);
  persistence.dispose();
});

test('task đã kết thúc thì bản ghi bị xóa chứ không được lưu tiếp', async () => {
  for (const state of ['completed', 'failed', 'canceled'] as const) {
    const { store, persistence } = makePersistence();
    const task = makeTask();

    persistence.touch(task);
    await persistence.settled();
    assert.ok(store.data.has(recordKey('task-1')), `${state}: cần có bản ghi trước đã`);

    task.state = state;
    persistence.touch(task);
    await persistence.settled();
    assert.equal(store.data.has(recordKey('task-1')), false, `${state}: bản ghi phải biến mất`);
  }
});

test('trạng thái quá độ không xóa bản ghi cũ, để lỡ chết lúc ghép file vẫn cứu được', async () => {
  const { store, persistence } = makePersistence();
  const task = makeTask();

  persistence.touch(task);
  await persistence.settled();

  task.state = 'assembling';
  persistence.touch(task);
  await persistence.settled();
  assert.ok(store.data.has(recordKey('task-1')));
});

test('forget() xóa đúng khóa và không đụng khóa khác', async () => {
  const { store, persistence } = makePersistence();
  store.data.set('settings', { autoMode: true });
  persistence.touch(makeTask());
  await persistence.settled();

  await persistence.forget('task-1');
  assert.equal(store.data.has(recordKey('task-1')), false);
  assert.ok(store.data.has('settings'));
});

test('checkpoint ghi ngay lập tức, không chờ nhịp nào cả', async () => {
  const { store, persistence } = makePersistence({ intervalMs: 60_000 });
  await persistence.checkpoint(makeTask({ state: 'paused' }));
  const raw = store.data.get(recordKey('task-1'));
  const record = must(decodeRecord(raw), 'checkpoint phải ghi ra một bản ghi đọc lại được');
  assert.equal(record.state, 'paused');
  assert.equal(record.received, PIECE);
});

test('lỗi lưu trữ được nuốt và báo lại, không làm chết lượt tải đang chạy', async () => {
  const errors: unknown[] = [];
  const store: PersistenceStore = {
    async read() {
      return {};
    },
    async write() {
      throw new Error('QuotaExceededError');
    },
    async remove() {},
  };
  const persistence = new TaskPersistence(store, {}, { onError: (err) => errors.push(err) });
  await persistence.checkpoint(makeTask());
  assert.equal(errors.length, 1);
  persistence.dispose();
});

test('selectStale loại bản ghi quá hạn', () => {
  const now = 10_000_000;
  const maxAgeMs = DEFAULT_PERSISTENCE_OPTIONS.maxAgeMs;
  const fresh = makeRecord({ id: 'fresh', updatedAt: now - 1000 });
  const old = makeRecord({ id: 'old', updatedAt: now - maxAgeMs - 1 });

  const { keep, drop } = selectStale([fresh, old], now, {
    maxRecords: 50,
    maxAgeMs,
  });
  assert.deepEqual(keep.map((r) => r.id), ['fresh']);
  assert.deepEqual(drop.map((r) => r.id), ['old']);
});

test('selectStale giữ đúng số bản ghi mới nhất và loại phần còn lại', () => {
  const now = 10_000_000;
  const records = [1, 2, 3, 4, 5].map((n) =>
    makeRecord({ id: `t${n}`, updatedAt: now - n * 1000 }),
  );
  const { keep, drop } = selectStale(records, now, { maxRecords: 2, maxAgeMs: 1_000_000 });
  assert.deepEqual(keep.map((r) => r.id), ['t1', 't2']);
  assert.deepEqual(drop.map((r) => r.id).sort(), ['t3', 't4', 't5']);
});

test('loadAll dọn khóa hỏng, báo lại removedIds và không đụng dữ liệu người khác', async () => {
  const now = 30 * 24 * 60 * 60 * 1000; // Đủ xa để bản ghi cũ vượt hạn 7 ngày.
  const store = memoryStore({
    settings: { autoMode: true },
    [recordKey('good')]: makeRecord({ id: 'good', updatedAt: now - 1000 }),
    [recordKey('bad')]: { version: 99, id: 'bad' },
    [recordKey('mismatch')]: makeRecord({ id: 'someone-else', updatedAt: now - 1000 }),
    [recordKey('stale')]: makeRecord({ id: 'stale', updatedAt: 1 }),
  });
  const clock = manualClock(now);
  const persistence = new TaskPersistence(store, {}, { now: clock.now });

  const { records, removedIds } = await persistence.loadAll();

  assert.deepEqual(records.map((r) => r.id), ['good']);
  assert.deepEqual([...removedIds].sort(), ['bad', 'mismatch', 'stale']);
  assert.ok(store.data.has('settings'), 'khóa settings không phải việc của persistence');
  assert.ok(store.data.has(recordKey('good')));
  assert.equal(store.data.has(recordKey('bad')), false);
  persistence.dispose();
});

test('dispose() ngừng nhận touch để engine tắt không kéo theo lần ghi muộn', async () => {
  const { store, persistence } = makePersistence();
  persistence.dispose();
  persistence.touch(makeTask());
  await persistence.settled();
  assert.equal(store.writes, 0);
});

test('chuyển sang trạng thái quá độ giữa lúc chờ ghi cũng không xóa bản ghi', async () => {
  const { store, persistence } = makePersistence({ intervalMs: 60_000 });
  const task = makeTask();

  persistence.touch(task);
  await persistence.settled();

  // Bẩn hóa rồi đổi trạng thái trước khi lần ghi kịp chạy.
  advanceProgress(task, 4096);
  persistence.touch(task);
  task.state = 'assembling';
  await persistence.flushPending();

  assert.ok(store.data.has(recordKey('task-1')), 'bản ghi phải sống qua bước ghép file');
});

/* ---------- 6. Bản ghi không được vượt quá thứ đã nằm trên đĩa ---------- */

test('ảnh chụp piece được lấy trước barrier nên bản ghi luôn là cận dưới', async () => {
  const store = memoryStore();
  const task = makeTask();
  const persistence = new TaskPersistence(
    store,
    {},
    {
      barrier: async () => {
        // Trong lúc writer đang xả đệm, fetch worker vẫn báo thêm byte mới về.
        advanceProgress(task, 2 * MB);
      },
    },
  );

  await persistence.checkpoint(task);
  const record = must(decodeRecord(store.data.get(recordKey('task-1'))), 'phải có bản ghi');
  assert.equal(
    record.received,
    PIECE,
    'byte đến sau ảnh chụp chưa chắc đã qua flush, không được tính vào bản ghi',
  );
  persistence.dispose();
});

test('barrier hỏng thì hoãn ghi và giữ nguyên bản ghi cũ, không mất tiến độ', async () => {
  const store = memoryStore();
  const sched = manualScheduler();
  const errors: unknown[] = [];
  let broken = true;
  const persistence = new TaskPersistence(
    store,
    {},
    {
      schedule: sched.schedule,
      onError: (err) => errors.push(err),
      barrier: async () => {
        if (broken) throw new Error('writer worker đã chết');
      },
    },
  );

  await persistence.checkpoint(makeTask());
  assert.equal(store.writes, 0, 'chưa chứng minh được đã xả đệm thì chưa được tuyên bố');
  assert.equal(errors.length, 1);

  broken = false;
  await persistence.flushPending();
  assert.equal(store.writes, 1, 'tiến độ phải được chốt lại ở lần sau chứ không mất');
  const record = must(decodeRecord(store.data.get(recordKey('task-1'))), 'phải đọc lại được');
  assert.equal(record.received, PIECE);
  persistence.dispose();
});

test('barrier treo không được khóa cứng hàng đợi lưu trữ', async () => {
  const store = memoryStore();
  const sched = manualScheduler();
  const errors: unknown[] = [];
  let entered: () => void = () => {};
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const persistence = new TaskPersistence(
    store,
    {},
    {
      schedule: sched.schedule,
      onError: (err) => errors.push(err),
      barrier: () => {
        entered();
        // Writer bị terminate giữa chừng: lệnh flush không bao giờ được đáp.
        return new Promise<void>(() => {});
      },
    },
  );

  const pending = persistence.checkpoint(makeTask());
  await reached;
  sched.runDue(); // Hạn chờ barrier hết giờ.
  await pending;

  assert.equal(store.writes, 0);
  assert.equal(errors.length, 1, 'quá hạn phải được báo ra chứ không im lặng');
  persistence.dispose();
});

test('bản ghi vượt trần chỉ báo lỗi một lần chứ không mỗi gói tiến độ', async () => {
  const store = memoryStore();
  const clock = manualClock();
  const sched = manualScheduler();
  const errors: unknown[] = [];
  const persistence = new TaskPersistence(
    store,
    { maxRecordBytes: 64 },
    { now: clock.now, schedule: sched.schedule, onError: (err) => errors.push(err) },
  );

  const task = makeTask();
  persistence.touch(task);
  await persistence.settled();
  assert.equal(store.writes, 0);
  assert.equal(errors.length, 1);

  for (let i = 0; i < 5; i++) {
    clock.advance(500);
    advanceProgress(task, 4096);
    persistence.touch(task);
    await persistence.settled();
  }
  assert.equal(errors.length, 1, 'lượt tải vẫn chạy, chỉ là không báo lỗi lặp lại');
  persistence.dispose();
});

/* ---------- 7. Cổng lưu trữ và sự cố lúc khởi động ---------- */

test('storeFromArea chỉ nhặt khóa đúng tiền tố và bỏ qua lời gọi rỗng', async () => {
  const data = new Map<string, unknown>([
    ['settings', { autoMode: true }],
    [recordKey('a'), { version: SCHEMA_VERSION }],
  ]);
  let sets = 0;
  let removes = 0;
  const store = storeFromArea({
    async get() {
      return Object.fromEntries(data);
    },
    async set(items) {
      sets += 1;
      for (const [key, value] of Object.entries(items)) data.set(key, value);
    },
    async remove(keys) {
      removes += 1;
      for (const key of keys) data.delete(key);
    },
  });

  assert.deepEqual(Object.keys(await store.read(RECORD_PREFIX)), [recordKey('a')]);
  await store.write({});
  await store.remove([]);
  assert.equal(sets, 0, 'ghi rỗng không được đánh thức tầng lưu trữ');
  assert.equal(removes, 0);

  await store.remove([recordKey('a')]);
  assert.ok(data.has('settings'));
  assert.equal(data.has(recordKey('a')), false);
});

test('mọi piece đã xong thì không cần Range nữa, đừng bắt tải lại file đã đủ', () => {
  const record = makeRecord({
    acceptRanges: false,
    pieces: { pieceSize: PIECE, count: 3, received: [PIECE, PIECE, 2 * MB] },
  });
  const verdict = reconcile(record, { exists: true, size: SIZE });
  assert.equal(verdict.action, 'resume');
  if (verdict.action !== 'resume') return;
  assert.equal(verdict.remaining, 0);
});

test('không đọc được thư mục parts thì giữ nguyên mọi thứ, tuyệt đối không dọn', async () => {
  const forgotten: string[] = [];
  const source: RecoverySource = {
    async loadAll() {
      return { records: [makeRecord({ id: 'a' }), makeRecord({ id: 'b' })], removedIds: [] };
    },
    async forget(id: string) {
      forgotten.push(id);
    },
  };
  const inspector: PartInspector = {
    async list(): Promise<Set<string>> {
      throw new Error('OPFS không dùng được lúc này');
    },
    async size() {
      return 0;
    },
    async remove() {},
  };

  const plan = await planRecovery(source, inspector);

  assert.equal(plan.partsUnreadable, true);
  assert.deepEqual([...plan.keep].sort(), ['a', 'b'], 'keep rỗng sẽ khiến cleanupOrphans xóa sạch');
  assert.deepEqual(forgotten, [], 'chưa biết trên đĩa có gì thì không được xóa bản ghi nào');
  assert.equal(plan.resumable.length, 0);
  assert.equal(plan.restartable.length, 0);
});

test('lỗi xóa bản ghi không làm chết cả bước khởi động', async () => {
  const source: RecoverySource = {
    async loadAll() {
      return { records: [makeRecord({ id: 'gone' })], removedIds: [] };
    },
    async forget() {
      throw new Error('storage.local từ chối');
    },
  };
  const inspector: PartInspector = {
    async list() {
      return new Set<string>();
    },
    async size() {
      return 0;
    },
    async remove() {},
  };

  const plan = await planRecovery(source, inspector);
  assert.equal(plan.discarded.length, 1, 'phải trả về kế hoạch để cleanupOrphans còn chạy được');
});
