import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { useMessageTable } from '../src/shared/i18n';
import { bytes, eta, speed, stateLabel, UNIT_KEYS, DURATION_KEYS } from '../src/ui/format';

/* ---------- Đọc bảng chuỗi từ đĩa ---------- */

/**
 * Test được bundle sang dist/test (npm test) hoặc chạy tay, nên không có đường
 * dẫn tương đối nào đúng cho cả hai. Đi ngược lên từ chỗ file đang nằm rồi thử
 * tiếp từ thư mục làm việc — giống `test/i18n.test.ts`.
 */
function repoRoot(): string {
  const starts = [path.dirname(fileURLToPath(import.meta.url)), process.cwd()];
  for (const start of starts) {
    let dir = start;
    for (let up = 0; up < 8; up += 1) {
      if (existsSync(path.join(dir, '_locales'))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  throw new Error('Không tìm thấy thư mục gốc chứa _locales');
}

interface Entry {
  message: string;
  description?: string;
}

function messages(locale: 'vi' | 'en'): Record<string, Entry> {
  const file = path.join(repoRoot(), '_locales', locale, 'messages.json');
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, Entry>;
}

const vi = messages('vi');
const en = messages('en');

/**
 * Lắp bảng chuỗi thật làm bảng ghi đè, giống `chrome.i18n` đã nạp đúng locale.
 * Mỗi test file là một bundle esbuild riêng nên module i18n ở đây là instance
 * riêng — không đụng chạm với `test/i18n.test.ts`.
 */
function withTable<T>(locale: 'vi' | 'en', fn: () => T): T {
  const table = Object.fromEntries(
    Object.entries(locale === 'vi' ? vi : en).map(([k, v]) => [k, v.message]),
  );
  useMessageTable(table);
  try {
    return fn();
  } finally {
    useMessageTable(null);
  }
}

/** Tắt cảnh báo thiếu key ra console khi test cố tình tra key không có. */
function quietly<T>(fn: () => T): T {
  const original = console.warn;
  console.warn = () => {};
  try {
    return fn();
  } finally {
    console.warn = original;
  }
}

const STATES = [
  'queued',
  'probing',
  'downloading',
  'paused',
  'assembling',
  'completed',
  'failed',
  'canceled',
] as const;

/* ---------- stateLabel ---------- */

test('stateLabel trả bản dịch tiếng Việt (locale mặc định)', () => {
  withTable('vi', () => {
    assert.equal(stateLabel('queued'), 'Đang chờ');
    assert.equal(stateLabel('probing'), 'Đang thăm dò');
    assert.equal(stateLabel('downloading'), 'Đang tải');
    assert.equal(stateLabel('failed'), 'Lỗi');
    assert.equal(stateLabel('canceled'), 'Đã hủy');
  });
});

test('stateLabel trả bản dịch tiếng Anh khi lắp bảng en', () => {
  withTable('en', () => {
    assert.equal(stateLabel('queued'), 'Queued');
    assert.equal(stateLabel('completed'), 'Done');
    assert.equal(stateLabel('assembling'), 'Finishing');
  });
});

test('stateLabel không trả lại chính key khi đã có bảng chuỗi', () => {
  withTable('vi', () => {
    for (const state of STATES) {
      const label = stateLabel(state);
      assert.ok(label, `state_${state} rỗng`);
      assert.notEqual(label, `state_${state}`, `state_${state} trả key thay vì dịch`);
    }
  });
});

test('stateLabel rơi về tên trạng thái khi thiếu key (giữ dự phòng cũ)', () => {
  // Node không có chrome.i18n và chưa lắp bảng, nên `t()` trả fallback. Giống
  // `STATE_LABEL[task.state] ?? task.state` trước đây: thiếu thì trả chính state.
  quietly(() => assert.equal(stateLabel('queued'), 'queued'));
});

/* ---------- Tồn tại key ở cả hai locale ---------- */

test('mọi key state_* có ở cả vi và en', () => {
  for (const state of STATES) {
    const key = `state_${state}`;
    assert.ok(key in vi, `thiếu vi/${key}`);
    assert.ok(key in en, `thiếu en/${key}`);
  }
});

test('mọi key đơn vị dùng trong format.ts có ở cả vi và en', () => {
  const keys = [...UNIT_KEYS, 'unit_per_second', 'common_unknown', ...DURATION_KEYS];
  for (const key of keys) {
    assert.ok(key in vi, `thiếu vi/${key}`);
    assert.ok(key in en, `thiếu en/${key}`);
  }
});

/* ---------- bytes / speed / eta ---------- */

test('bytes định dạng qua unit_* và common_unknown', () => {
  withTable('vi', () => {
    assert.equal(bytes(0), '0 B');
    assert.equal(bytes(512), '512 B');
    assert.equal(bytes(2048), '2.0 KB');
    assert.equal(bytes(1048576), '1.0 MB');
    assert.equal(bytes(NaN), '—');
    assert.equal(bytes(-5), '—');
  });
});

test('speed ghép unit_per_second quanh bytes()', () => {
  withTable('vi', () => {
    assert.equal(speed(2048), '2.0 KB/s');
    assert.equal(speed(0), '—');
  });
  withTable('en', () => {
    assert.equal(speed(2048), '2.0 KB/s');
  });
});

test('eta dùng duration_* và common_unknown', () => {
  withTable('vi', () => {
    assert.equal(eta(0, 1000, 0), '—'); // bytesPerSecond <= 0
    assert.equal(eta(0, null, 100), '—'); // total null
    assert.equal(eta(900, 1000, 10), '10 giây'); // (1000-900)/10 = 10s
    assert.equal(eta(0, 6000, 100), '1 phút 0 giây'); // 60s
    assert.equal(eta(0, 9000000, 1000), '2 giờ 30 phút'); // 9000s
  });
  withTable('en', () => {
    assert.equal(eta(900, 1000, 10), '10s');
    assert.equal(eta(0, 6000, 100), '1m 0s');
    assert.equal(eta(0, 9000000, 1000), '2h 30m');
  });
});

test('bytes/speed/eta không rò rỉ key thô khi có bảng chuỗi', () => {
  withTable('vi', () => {
    for (const out of [bytes(2048), speed(2048), eta(900, 1000, 10)]) {
      assert.ok(!out.startsWith('unit_'), `rò rỉ key: ${out}`);
      assert.ok(!out.startsWith('duration_'), `rò rỉ key: ${out}`);
      assert.ok(!out.startsWith('common_'), `rò rỉ key: ${out}`);
    }
  });
});
