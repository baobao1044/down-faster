import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { useMessageTable } from '../src/shared/i18n';
import {
  normalizeCreative,
  pickProvider,
  buildHouseFallback,
  resolveCreative,
  DEFAULT_ADS_CONFIG,
  type AdsConfig,
} from '../src/ui/ads';

/* ---------- Bảng chuỗi (giống format.test.ts) ---------- */

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

/** Chạy fn với bảng chuỗi tiếng Việt nạp (cho buildHouseFallback tra t() được). */
function withViLocale<T>(fn: () => T): T {
  const vi = messages('vi');
  const table: Record<string, string> = {};
  for (const [k, v] of Object.entries(vi)) table[k] = v.message;
  useMessageTable(table);
  try {
    return fn();
  } finally {
    useMessageTable(null);
  }
}

/* ---------- normalizeCreative ---------- */

test('normalizeCreative chấp nhận creative hợp lệ', () => {
  const creative = normalizeCreative({
    sponsor: 'ACME',
    text: 'Mua ngay',
    linkUrl: 'https://acme.example/sale',
    imageUrl: 'https://cdn.example/ad.png',
  });
  assert.equal(creative?.sponsor, 'ACME');
  assert.equal(creative?.text, 'Mua ngay');
  assert.equal(creative?.linkUrl, 'https://acme.example/sale');
  assert.equal(creative?.imageUrl, 'https://cdn.example/ad.png');
});

test('normalizeCreative rơi về null khi thiếu field bắt buộc', () => {
  assert.equal(normalizeCreative(null), null);
  assert.equal(normalizeCreative('không phải object'), null);
  assert.equal(normalizeCreative({ sponsor: 'A', text: 'B' }), null); // thiếu linkUrl
  assert.equal(normalizeCreative({ text: 'B', linkUrl: 'https://x' }), null); // thiếu sponsor
  assert.equal(normalizeCreative({ sponsor: 'A', linkUrl: 'https://x' }), null); // thiếu text
  assert.equal(normalizeCreative({ sponsor: '', text: 'B', linkUrl: 'https://x' }), null); // sponsor rỗng
});

test('normalizeCreative chặn linkUrl không phải http/https', () => {
  assert.equal(
    normalizeCreative({ sponsor: 'A', text: 'B', linkUrl: 'javascript:alert(1)' }),
    null,
  );
  assert.equal(
    normalizeCreative({ sponsor: 'A', text: 'B', linkUrl: 'data:text/html,<script>' }),
    null,
  );
  assert.equal(normalizeCreative({ sponsor: 'A', text: 'B', linkUrl: 'ftp://x' }), null);
});

test('normalizeCreative chấp nhận http:// (không chỉ https)', () => {
  const creative = normalizeCreative({ sponsor: 'A', text: 'B', linkUrl: 'http://x.example' });
  assert.equal(creative?.linkUrl, 'http://x.example');
});

test('normalizeCreative bỏ imageUrl hỏng nhưng vẫn giữ creative', () => {
  const creative = normalizeCreative({
    sponsor: 'A',
    text: 'B',
    linkUrl: 'https://x.example',
    imageUrl: 'không phải URL',
  });
  assert.equal(creative?.imageUrl, undefined);
  assert.equal(creative?.text, 'B');
});

test('normalizeCreative bỏ imageUrl với protocol lạ', () => {
  const creative = normalizeCreative({
    sponsor: 'A',
    text: 'B',
    linkUrl: 'https://x.example',
    imageUrl: 'javascript:alert(1)',
  });
  assert.equal(creative?.imageUrl, undefined);
});

/* ---------- pickProvider ---------- */

test('pickProvider trả house khi networkEnabled = false', () => {
  assert.equal(pickProvider(DEFAULT_ADS_CONFIG), 'house');
  assert.equal(pickProvider({ networkEnabled: false, networkEndpoint: 'https://x' }), 'house');
});

test('pickProvider trả network khi bật + có endpoint', () => {
  assert.equal(
    pickProvider({ networkEnabled: true, networkEndpoint: 'https://ads.example/creative' }),
    'network',
  );
});

test('pickProvider rơi về house khi bật nhưng thiếu endpoint', () => {
  assert.equal(pickProvider({ networkEnabled: true, networkEndpoint: undefined }), 'house');
  assert.equal(pickProvider({ networkEnabled: true, networkEndpoint: '' }), 'house');
});

/* ---------- buildHouseFallback ---------- */

test('buildHouseFallback trả creative trỏ tới repo GitHub', () => {
  withViLocale(() => {
    const creative = buildHouseFallback();
    assert.ok(creative.linkUrl.startsWith('https://github.com/'), 'linkUrl phải là GitHub');
    assert.ok(creative.text.length > 0, 'text không rỗng');
    assert.ok(creative.sponsor.length > 0, 'sponsor không rỗng');
  });
});

test('buildHouseFallback dùng chuỗi tiếng Việt khi bảng vi nạp', () => {
  withViLocale(() => {
    const creative = buildHouseFallback();
    assert.equal(creative.sponsor, 'Down Faster');
    assert.equal(creative.text, 'Down Faster miễn phí. Star trên GitHub để ủng hộ dự án.');
  });
});

test('buildHouseFallback dùng chuỗi tiếng Anh khi bảng en nạp', () => {
  const en = messages('en');
  const table: Record<string, string> = {};
  for (const [k, v] of Object.entries(en)) table[k] = v.message;
  useMessageTable(table);
  try {
    const creative = buildHouseFallback();
    assert.equal(creative.sponsor, 'Down Faster');
    assert.equal(creative.text, 'Down Faster is free and open. Star it on GitHub to support development.');
  } finally {
    useMessageTable(null);
  }
});

/* ---------- resolveCreative ---------- */

test('resolveCreative trả house ad khi network TẮT (không gọi fetch)', async () => {
  let fetchCalled = false;
  const fakeFetch = (() => {
    fetchCalled = true;
    return Promise.resolve({} as Response);
  }) as typeof fetch;

  const creative = await resolveCreative(DEFAULT_ADS_CONFIG, fakeFetch);
  assert.ok(creative, 'phải có creative');
  assert.equal(fetchCalled, false, 'không gọi fetch khi network TẮT');
});

test('resolveCreative fetch JSON khi network BẬT', async () => {
  let calledUrl: string | undefined;
  let calledOpts: RequestInit | undefined;
  const fakeFetch = ((url: string, opts?: RequestInit) => {
    calledUrl = url;
    calledOpts = opts;
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ sponsor: 'Net', text: 'Net ad', linkUrl: 'https://net.example' }),
    } as Response);
  }) as typeof fetch;

  const config: AdsConfig = {
    networkEnabled: true,
    networkEndpoint: 'https://ads.example/creative',
  };
  const creative = await resolveCreative(config, fakeFetch);

  assert.equal(calledUrl, 'https://ads.example/creative');
  assert.equal(calledOpts?.credentials, 'omit', 'phải dùng credentials: omit (bảo vệ privacy)');
  assert.equal(creative?.sponsor, 'Net');
  assert.equal(creative?.linkUrl, 'https://net.example');
});

test('resolveCreative rơi về house khi network trả HTTP lỗi', async () => {
  const fakeFetch = (() =>
    Promise.resolve({ ok: false, status: 500 } as Response)) as typeof fetch;
  const config: AdsConfig = {
    networkEnabled: true,
    networkEndpoint: 'https://ads.example/creative',
  };
  const creative = await resolveCreative(config, fakeFetch);
  // House fallback: linkUrl là repo GitHub, không phải network URL.
  assert.ok(creative?.linkUrl.startsWith('https://github.com/'), 'rơi về house ad');
});

test('resolveCreative rơi về house khi fetch ném lỗi (mất mạng)', async () => {
  const fakeFetch = (() => Promise.reject(new TypeError('Failed to fetch'))) as typeof fetch;
  const config: AdsConfig = {
    networkEnabled: true,
    networkEndpoint: 'https://ads.example/creative',
  };
  const creative = await resolveCreative(config, fakeFetch);
  assert.ok(creative?.linkUrl.startsWith('https://github.com/'), 'rơi về house ad khi fetch ném');
});

test('resolveCreative rơi về house khi network trả creative không hợp lệ', async () => {
  const fakeFetch = (() =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ sponsor: 'X', text: 'Y' }), // thiếu linkUrl
    } as Response)) as typeof fetch;
  const config: AdsConfig = {
    networkEnabled: true,
    networkEndpoint: 'https://ads.example/creative',
  };
  const creative = await resolveCreative(config, fakeFetch);
  assert.ok(creative?.linkUrl.startsWith('https://github.com/'), 'rơi về house khi JSON hỏng');
});

/* ---------- DEFAULT_ADS_CONFIG ---------- */

test('DEFAULT_ADS_CONFIG có networkEnabled = false (mặc định chỉ house)', () => {
  assert.equal(DEFAULT_ADS_CONFIG.networkEnabled, false);
  assert.equal(DEFAULT_ADS_CONFIG.networkEndpoint, undefined);
});
