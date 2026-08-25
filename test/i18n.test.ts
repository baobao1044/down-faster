import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  TRANSLATABLE_ATTRIBUTES,
  format,
  hasMessage,
  t,
  translatedAttributeName,
  useMessageTable,
} from '../src/shared/i18n';
import {
  MILESTONE_DEFAULTS,
  announce,
  clearAnnouncements,
  initA11y,
  milestoneFor,
  type AnnounceableTask,
  type TaskMemory,
} from '../src/ui/a11y';

/* ---------- Đọc bảng chuỗi từ đĩa ---------- */

/**
 * Test được bundle sang dist/test (npm test) hoặc sang /tmp (chạy tay), nên
 * không có đường dẫn tương đối nào đúng cho cả hai. Đi ngược lên từ chỗ file
 * đang nằm, rồi thử tiếp từ thư mục làm việc.
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

/** Mọi file .ts dưới src/, để soi key i18n thật sự đang được gọi. */
function sourceFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) walk(full);
      else if (item.name.endsWith('.ts')) found.push(full);
    }
  };
  walk(path.join(repoRoot(), 'src'));
  return found;
}

function tokens(message: string): Set<string> {
  const token = new RegExp('\\{([a-zA-Z][a-zA-Z0-9_]*)\\}', 'g');
  return new Set([...message.matchAll(token)].map((m) => m[1] as string));
}

const vi = messages('vi');
const en = messages('en');

/** Key thiếu sẽ được cảnh báo ra console; trong test đó chỉ là nhiễu. */
function quietly<T>(fn: () => T): T {
  const original = console.warn;
  console.warn = () => {};
  try {
    return fn();
  } finally {
    console.warn = original;
  }
}

/* ---------- Thay tham số ---------- */

test('thay được nhiều token trong một câu', () => {
  assert.equal(format('{a} và {b}', { a: 'x', b: 'y' }), 'x và y');
});

test('token lặp lại được thay ở mọi chỗ', () => {
  assert.equal(format('{n} + {n}', { n: 2 }), '2 + 2');
});

test('số được chuyển thành chuỗi', () => {
  assert.equal(format('Kết nối: {count}', { count: 8 }), 'Kết nối: 8');
  assert.equal(format('{count}×', { count: 0 }), '0×');
});

test('token thiếu tham số thì giữ nguyên để lỗi lộ ra', () => {
  assert.equal(format('còn {eta}', {}), 'còn {eta}');
  assert.equal(format('còn {eta}', { other: 1 }), 'còn {eta}');
});

test('không truyền params thì trả nguyên template', () => {
  assert.equal(format('còn {eta}'), 'còn {eta}');
});

test('chuỗi không có token đi qua nguyên vẹn', () => {
  assert.equal(format('Đang tải', { n: 1 }), 'Đang tải');
});

test('token trùng tên thuộc tính của prototype không moi ra hàm', () => {
  // `{toString}` mà tra bằng `in` sẽ nhả ra mã nguồn của Object.prototype.toString.
  assert.equal(format('{toString}', {}), '{toString}');
});

/* ---------- Dự phòng khi thiếu key ---------- */
/* Node không có chrome.i18n, nên nhánh "API vắng mặt" được kiểm tự nhiên. */

test('có bảng chuỗi thì trả bản dịch', () => {
  useMessageTable({ greeting: 'Xin chào' });
  assert.equal(t('greeting'), 'Xin chào');
  useMessageTable(null);
});

test('thiếu key mà có fallback thì trả fallback', () => {
  quietly(() => assert.equal(t('khong_co_key_nay', undefined, 'Dự phòng'), 'Dự phòng'));
});

test('thiếu key và không fallback thì trả chính key, để grep ra được', () => {
  quietly(() => assert.equal(t('khong_co_key_nay'), 'khong_co_key_nay'));
});

test('tham số được thay cả trên đường fallback', () => {
  quietly(() => assert.equal(t('khong_co', { n: 3 }, 'còn {n}'), 'còn 3'));
});

test('bảng chuỗi có chuỗi rỗng vẫn coi là thiếu', () => {
  // getMessage cũng trả '' khi thiếu key, nên hai đường phải hành xử giống nhau.
  useMessageTable({ trong: '' });
  quietly(() => assert.equal(t('trong', undefined, 'Dự phòng'), 'Dự phòng'));
  useMessageTable(null);
});

test('hasMessage phân biệt được có và không', () => {
  useMessageTable({ co: 'Có' });
  assert.equal(hasMessage('co'), true);
  assert.equal(hasMessage('khong'), false);
  useMessageTable(null);
});

test('useMessageTable(null) khôi phục trạng thái', () => {
  useMessageTable({ tam: 'Tạm' });
  assert.equal(t('tam'), 'Tạm');
  useMessageTable(null);
  quietly(() => assert.equal(t('tam'), 'tam'));
});

/* ---------- Danh sách trắng thuộc tính ---------- */

test('thuộc tính trong danh sách trắng được nhận', () => {
  assert.equal(translatedAttributeName('data-i18n-title'), 'title');
  assert.equal(translatedAttributeName('data-i18n-placeholder'), 'placeholder');
  assert.equal(translatedAttributeName('data-i18n-aria-label'), 'aria-label');
});

test('thuộc tính nguy hiểm không bao giờ được dịch', () => {
  assert.equal(translatedAttributeName('data-i18n-href'), null);
  assert.equal(translatedAttributeName('data-i18n-src'), null);
  assert.equal(translatedAttributeName('data-i18n-onclick'), null);
});

test('tên không có tiền tố data-i18n- thì không phải chỗ dịch', () => {
  assert.equal(translatedAttributeName('title'), null);
  assert.equal(translatedAttributeName('data-i18n'), null);
  assert.equal(translatedAttributeName('data-i18n-args'), null);
});

test('danh sách trắng production đúng bằng danh sách đã ghim', () => {
  // `translateElement` lặp thẳng trên TRANSLATABLE_ATTRIBUTES chứ không hề gọi
  // `translatedAttributeName`. Nếu chỉ có ba test ở trên thì thêm 'href' vào
  // hằng số này vẫn xanh hết — phải ghim chính cái mảng mà production đọc.
  assert.deepEqual([...TRANSLATABLE_ATTRIBUTES].sort(), [
    'alt',
    'aria-description',
    'aria-label',
    'aria-valuetext',
    'label',
    'placeholder',
    'title',
  ]);
});

test('không thuộc tính chạy được mã nào lọt vào danh sách trắng', () => {
  const dangerous = [
    'href',
    'src',
    'srcdoc',
    'action',
    'formaction',
    'poster',
    'style',
    'onclick',
    'onerror',
    'onload',
    'xlink:href',
  ];
  for (const name of dangerous) {
    assert.ok(!TRANSLATABLE_ATTRIBUTES.includes(name), `${name} không được dịch qua data-i18n-*`);
  }
});

/* ---------- Đối chiếu vi và en ---------- */

test('hai ngôn ngữ có cùng tập key', () => {
  const a = Object.keys(vi);
  const b = Object.keys(en);
  const missingInEn = a.filter((k) => !(k in en));
  const missingInVi = b.filter((k) => !(k in vi));
  assert.deepEqual(missingInEn, [], `thiếu bản tiếng Anh cho: ${missingInEn.join(', ')}`);
  assert.deepEqual(missingInVi, [], `thừa key chỉ có ở tiếng Anh: ${missingInVi.join(', ')}`);
});

test('mọi message đều khác rỗng', () => {
  for (const [locale, table] of [
    ['vi', vi],
    ['en', en],
  ] as const) {
    for (const [key, entry] of Object.entries(table)) {
      assert.equal(typeof entry.message, 'string', `${locale}/${key} thiếu trường message`);
      assert.notEqual(entry.message.trim(), '', `${locale}/${key} rỗng`);
    }
  }
});

test('key đúng quy ước ^[a-z][a-z0-9_]*$', () => {
  const shape = /^[a-z][a-z0-9_]*$/;
  for (const key of Object.keys(vi)) {
    assert.ok(shape.test(key), `key sai quy ước: ${key}`);
  }
});

test('không có hai key trùng nhau khi hạ hoa', () => {
  // Chrome hạ hoa tên key khi tra, nên popupAutoTitle và popup_auto_title vẫn
  // khác nhau ở đây nhưng có thể đụng nhau trên bản build thật.
  const seen = new Map<string, string>();
  for (const key of Object.keys(vi)) {
    const lower = key.toLowerCase();
    const previous = seen.get(lower);
    assert.equal(previous, undefined, `${key} và ${previous} trùng nhau sau khi hạ hoa`);
    seen.set(lower, key);
  }
});

test('mỗi key có cùng tập token ở cả hai ngôn ngữ', () => {
  for (const [key, entry] of Object.entries(vi)) {
    const other = en[key];
    if (!other) continue;
    const a = [...tokens(entry.message)].sort();
    const b = [...tokens(other.message)].sort();
    assert.deepEqual(b, a, `${key}: token vi [${a.join(',')}] khác en [${b.join(',')}]`);
  }
});

test('không message nào chứa ký tự đô la', () => {
  // chrome.i18n coi $ là cú pháp thay thế và sẽ ăn mất phần chuỗi quanh nó —
  // hỏng lặng lẽ trên bản build thật mà mọi test khác vẫn xanh.
  for (const [locale, table] of [
    ['vi', vi],
    ['en', en],
  ] as const) {
    for (const [key, entry] of Object.entries(table)) {
      assert.ok(!entry.message.includes('$'), `${locale}/${key} chứa ký tự đô la`);
    }
  }
});

test('bản vi có description cho mọi key', () => {
  for (const [key, entry] of Object.entries(vi)) {
    assert.equal(typeof entry.description, 'string', `vi/${key} thiếu description`);
    assert.notEqual((entry.description ?? '').trim(), '', `vi/${key} có description rỗng`);
  }
});

test('mọi key i18n gõ thẳng trong src đều có trong bảng chuỗi', () => {
  // `t()` cố tình không ném lỗi khi thiếu key: nó trả về chính cái key. Nhờ vậy
  // UI không trắng, nhưng cũng vì vậy một key gõ sai chỉ lộ ra dưới dạng chữ
  // 'a11y_completd' trên màn hình người dùng. Đây là hàng rào duy nhất bắt được.
  const patterns = [
    new RegExp("\\bt\\(\\s*'([a-z][a-z0-9_]*)'", 'g'),
    new RegExp("\\bhasMessage\\(\\s*'([a-z][a-z0-9_]*)'", 'g'),
    new RegExp("\\bi18n:\\s*'([a-z][a-z0-9_]*)'", 'g'),
    new RegExp("\\bsetI18nText\\([^,]+,\\s*'([a-z][a-z0-9_]*)'", 'g'),
  ];

  const missing: string[] = [];
  for (const file of sourceFiles()) {
    const source = readFileSync(file, 'utf8');
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) {
        const key = match[1] as string;
        if (!(key in vi)) missing.push(`${path.basename(file)}: ${key}`);
      }
    }
  }
  assert.deepEqual(missing, [], `key không có trong _locales/vi: ${missing.join(', ')}`);
});

test('mỗi trạng thái của engine đều có nhãn state_*', () => {
  // a11y.ts tra nhãn bằng key ghép `state_${task.state}`, nên regex ở test trên
  // không thấy. Engine thêm một trạng thái mà quên thêm chuỗi thì trình đọc màn
  // hình sẽ đọc lên đúng cái định danh tiếng Anh trong mã nguồn.
  const types = readFileSync(path.join(repoRoot(), 'src', 'engine', 'types.ts'), 'utf8');
  const union = /export type DownloadState =([\s\S]*?);/.exec(types);
  assert.ok(union, 'không tìm thấy union DownloadState trong types.ts');
  const states = [...(union[1] as string).matchAll(/'([a-z_]+)'/g)].map((m) => m[1] as string);
  assert.ok(states.length >= 8, `chỉ đọc được ${states.length} trạng thái, regex hỏng rồi`);
  for (const state of states) {
    assert.ok(`state_${state}` in vi, `thiếu vi/state_${state}`);
    assert.ok(`state_${state}` in en, `thiếu en/state_${state}`);
  }
});

test('locale_bcp47 khớp tên thư mục', () => {
  assert.equal(vi['locale_bcp47']?.message, 'vi');
  assert.equal(en['locale_bcp47']?.message, 'en');
});

test('bảng chuỗi thật dùng được qua useMessageTable', () => {
  const table = Object.fromEntries(Object.entries(vi).map(([k, v]) => [k, v.message]));
  useMessageTable(table);
  assert.equal(t('manager_connections', { count: 8 }), 'Kết nối: 8');
  assert.equal(t('state_completed'), 'Xong');
  useMessageTable(null);
});

/* ---------- Mốc thông báo trợ năng ---------- */

const task = (over: Partial<AnnounceableTask> = {}): AnnounceableTask => ({
  id: 'a',
  filename: 'phim.mkv',
  state: 'downloading',
  received: 0,
  size: 1000,
  ...over,
});

const memory = (over: Partial<TaskMemory> = {}): TaskMemory => ({
  state: 'downloading',
  percentAnnounced: 0,
  at: 0,
  ...over,
});

test('lần đầu thấy một lượt tải thì luôn có mốc trạng thái', () => {
  const { milestone } = milestoneFor(undefined, task(), 0);
  assert.equal(milestone?.kind, 'state');
});

test('đổi trạng thái thì luôn có mốc, kể cả trạng thái không có câu riêng', () => {
  for (const state of ['queued', 'probing', 'paused', 'assembling', 'completed', 'canceled']) {
    const { milestone } = milestoneFor(memory(), task({ state }), 1000);
    assert.equal(milestone?.kind, 'state', `${state} phải có mốc`);
    assert.notEqual(milestone?.text.trim(), '');
  }
});

test('chạy tiếp sau khi tạm dừng khác với bắt đầu tải', () => {
  const started = milestoneFor(memory({ state: 'queued' }), task(), 0).milestone;
  const resumed = milestoneFor(memory({ state: 'paused' }), task(), 0).milestone;
  assert.notEqual(started?.text, resumed?.text);
});

test('thất bại được đọc ở mức assertive', () => {
  const failed = task({ state: 'failed', error: 'Server đóng kết nối' });
  const { milestone } = milestoneFor(memory(), failed, 0);
  assert.equal(milestone?.politeness, 'assertive');
});

test('trạng thái khác thất bại thì đọc ở mức polite', () => {
  const { milestone } = milestoneFor(memory(), task({ state: 'completed' }), 0);
  assert.equal(milestone?.politeness, 'polite');
});

test('chưa qua bậc phần trăm thì im', () => {
  const at20 = task({ received: 200 });
  const { milestone } = milestoneFor(memory({ at: 0 }), at20, 60_000);
  assert.equal(milestone, null);
});

test('qua bậc nhưng chưa đủ giãn cách thì im', () => {
  const at50 = task({ received: 500 });
  const { milestone } = milestoneFor(memory({ at: 10_000 }), at50, 10_000 + 1_000);
  assert.equal(milestone, null);
});

test('qua bậc và đủ giãn cách thì đọc', () => {
  const at50 = task({ received: 500 });
  const now = MILESTONE_DEFAULTS.minGapMs + 1;
  const { milestone, memory: next } = milestoneFor(memory({ at: 0 }), at50, now);
  assert.equal(milestone?.kind, 'progress');
  assert.equal(next.percentAnnounced, 50);
  assert.equal(next.at, now);
});

test('mốc 0 phần trăm không được đọc', () => {
  const at0 = task({ received: 3 });
  const { milestone } = milestoneFor(memory({ at: 0 }), at0, 60_000);
  assert.equal(milestone, null);
});

test('không biết kích thước thì không đọc tiến độ', () => {
  const unknown = task({ size: null, received: 999_999 });
  const { milestone } = milestoneFor(memory({ at: 0 }), unknown, 60_000);
  assert.equal(milestone, null);
});

test('đã đọc bậc 50 rồi thì không đọc lại bậc 50', () => {
  const at50 = task({ received: 520 });
  const { milestone } = milestoneFor(memory({ percentAnnounced: 50, at: 0 }), at50, 60_000);
  assert.equal(milestone, null);
});

test('bước phần trăm và giãn cách tùy chỉnh được', () => {
  const at10 = task({ received: 100 });
  const { milestone } = milestoneFor(memory({ at: 0 }), at10, 1_000, {
    stepPercent: 10,
    minGapMs: 500,
  });
  assert.equal(milestone?.kind, 'progress');
});

test('memory chỉ nên ghi khi thật sự đọc, nên hàm phải thuần', () => {
  // Gọi hai lần với cùng previous phải cho cùng kết quả: người gọi bỏ qua mốc
  // này thì nhịp sau vẫn còn cơ hội đọc nó.
  const previous = memory({ at: 0 });
  const at50 = task({ received: 500 });
  const now = MILESTONE_DEFAULTS.minGapMs + 1;
  const first = milestoneFor(previous, at50, now);
  const second = milestoneFor(previous, at50, now);
  assert.deepEqual(second.memory, first.memory);
  assert.deepEqual(second.milestone, first.milestone);
  assert.deepEqual(previous, memory({ at: 0 }));
});

test('đổi trạng thái ghi luôn bậc hiện tại làm mốc đã đọc', () => {
  // Vừa nói "đã tiếp tục" xong mà đọc ngay "50 phần trăm" thì thừa.
  const at50 = task({ received: 500 });
  const { memory: next } = milestoneFor(memory({ state: 'paused' }), at50, 5_000);
  assert.equal(next.percentAnnounced, 50);
});

test('mốc tiến độ nói đúng bậc chứ không nói phần trăm lẻ', () => {
  const table = Object.fromEntries(Object.entries(vi).map(([k, v]) => [k, v.message]));
  useMessageTable(table);
  const at63 = task({ received: 637 });
  const { milestone } = milestoneFor(memory({ at: 0 }), at63, 60_000);
  assert.equal(milestone?.text, 'phim.mkv: 50 phần trăm');
  useMessageTable(null);
});

/* ---------- Vùng aria-live, chạy trên một DOM giả tối thiểu ---------- */

/**
 * `announce()` chỉ chạm vào một góc rất hẹp của DOM, nên giả lập đúng góc đó rẻ
 * hơn nhiều so với kéo cả jsdom về — mà dự án cũng cấm thêm dependency. Không
 * thay được việc kiểm tay bằng NVDA/Orca, nhưng đủ canh thứ dễ hỏng nhất và
 * cũng khó thấy nhất bằng mắt: hai vùng live giẫm lên nhịp chờ của nhau.
 */
class FakeElement {
  id = '';
  className = '';
  textContent = '';
  readonly style: Record<string, string> = {};
  private readonly attributes = new Map<string, string>();

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
}

class FakeDocument {
  readonly appended: FakeElement[] = [];
  readonly documentElement = { dataset: {} as Record<string, string> };
  readonly body = {
    appendChild: (node: FakeElement): void => {
      this.appended.push(node);
    },
  };

  createElement(): FakeElement {
    return new FakeElement();
  }

  getElementById(id: string): FakeElement | null {
    return this.appended.find((node) => node.id === id) ?? null;
  }
}

/** Dài hơn REPEAT_DELAY_MS (60ms) của a11y.ts, chừa biên cho máy CI chậm. */
const REPEAT_WAIT_MS = 150;

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** Cài DOM giả vào global quanh một đoạn test rồi trả lại nguyên trạng. */
async function withFakeDocument(fn: (doc: FakeDocument) => Promise<void>): Promise<void> {
  const holder = globalThis as unknown as { document?: unknown };
  const original = holder.document;
  const doc = new FakeDocument();
  holder.document = doc;
  try {
    await fn(doc);
    // Phải dọn khi DOM giả còn đứng đó: hẹn giờ còn treo sẽ ghi vào vùng của
    // document đã bị tháo và làm hỏng test chạy sau.
    clearAnnouncements();
  } finally {
    if (original === undefined) delete holder.document;
    else holder.document = original;
  }
}

test('initA11y dựng sẵn hai vùng live rỗng, đúng vai trò', async () => {
  await withFakeDocument(async (doc) => {
    initA11y();
    const polite = doc.getElementById('df-live-polite');
    const assertive = doc.getElementById('df-live-assertive');
    assert.ok(polite, 'thiếu vùng polite');
    assert.ok(assertive, 'thiếu vùng assertive');

    // Rỗng ngay từ đầu là chủ ý: trình đọc màn hình chỉ theo dõi vùng live đã có
    // mặt từ trước, dựng lười tới lúc thông báo đầu tiên sẽ nuốt mất câu đó.
    assert.equal(polite.textContent, '');
    assert.equal(polite.getAttribute('aria-live'), 'polite');
    assert.equal(polite.getAttribute('role'), 'status');
    assert.equal(assertive.getAttribute('aria-live'), 'assertive');
    assert.equal(assertive.getAttribute('role'), 'alert');
    assert.equal(doc.documentElement.dataset['motion'], 'full');
    await Promise.resolve();
  });
});

test('câu khẩn không nuốt mất nhịp đọc lại của vùng thường', async () => {
  await withFakeDocument(async (doc) => {
    initA11y();
    const polite = doc.getElementById('df-live-polite') as FakeElement;
    const assertive = doc.getElementById('df-live-assertive') as FakeElement;

    announce('Đã tải xong A', 'polite');
    assert.equal(polite.textContent, 'Đã tải xong A');

    // Đúng câu đó lần nữa: phải xóa trắng một nhịp rồi mới đặt lại, vì vài trình
    // đọc so sánh nội dung và bỏ qua khi không đổi.
    announce('Đã tải xong A', 'polite');
    assert.equal(polite.textContent, '');

    // Ngay giữa nhịp trống ấy, một tin thất bại xen vào vùng BÊN KIA.
    announce('Tải B thất bại', 'assertive');
    assert.equal(assertive.textContent, 'Tải B thất bại');

    await sleep(REPEAT_WAIT_MS);
    assert.equal(
      polite.textContent,
      'Đã tải xong A',
      'câu khẩn đã hủy mất hẹn giờ của vùng thường, câu kia không bao giờ được đọc',
    );
  });
});

test('câu mới cùng vùng thay hẳn câu đang chờ đọc lại', async () => {
  await withFakeDocument(async (doc) => {
    initA11y();
    const polite = doc.getElementById('df-live-polite') as FakeElement;

    announce('Đã tải xong A', 'polite');
    announce('Đã tải xong A', 'polite');
    assert.equal(polite.textContent, '');

    announce('Đã tải xong B', 'polite');
    assert.equal(polite.textContent, 'Đã tải xong B');

    await sleep(REPEAT_WAIT_MS);
    assert.equal(polite.textContent, 'Đã tải xong B', 'câu cũ không được sống lại');
  });
});

test('câu rỗng hoặc chỉ có khoảng trắng thì không đụng vào vùng live', async () => {
  await withFakeDocument(async (doc) => {
    initA11y();
    const polite = doc.getElementById('df-live-polite') as FakeElement;

    announce('Đã tải xong A', 'polite');
    announce('   ', 'polite');
    assert.equal(polite.textContent, 'Đã tải xong A');
    await Promise.resolve();
  });
});
