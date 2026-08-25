import { test } from 'node:test';
import assert from 'node:assert/strict';

import { planPieces, requeue, takeNextPending, totalReceived } from '../src/engine/pieces';
import { fromContentDisposition, fromUrl, sanitize } from '../src/engine/filename';
import { probe } from '../src/engine/probe';
import { DEFAULT_OPTIONS } from '../src/engine/types';

const MB = 1024 * 1024;

/* ---------- Chia piece ---------- */

test('file nhỏ chỉ dùng một piece vì chia luồng không bõ', () => {
  const pieces = planPieces(MB, DEFAULT_OPTIONS);
  assert.equal(pieces.length, 1);
  assert.equal(pieces[0]!.start, 0);
  assert.equal(pieces[0]!.end, MB - 1);
});

test('một kết nối thì luôn một piece dù file lớn', () => {
  const pieces = planPieces(500 * MB, { ...DEFAULT_OPTIONS, connections: 1 });
  assert.equal(pieces.length, 1);
});

test('các piece phủ kín file, không hở và không chồng lấn', () => {
  const size = 977 * MB + 12345; // Cố tình lẻ để lộ lỗi làm tròn.
  const pieces = planPieces(size, DEFAULT_OPTIONS);

  assert.equal(pieces[0]!.start, 0);
  assert.equal(pieces.at(-1)!.end, size - 1);

  for (let i = 1; i < pieces.length; i++) {
    assert.equal(
      pieces[i]!.start,
      pieces[i - 1]!.end + 1,
      `piece ${i} không nối liền piece trước`,
    );
  }

  const covered = pieces.reduce((sum, p) => sum + (p.end - p.start + 1), 0);
  assert.equal(covered, size);
});

test('mỗi kết nối được phát nhiều piece để kết nối chậm không giữ chân cả nhóm', () => {
  const pieces = planPieces(200 * MB, DEFAULT_OPTIONS);
  assert.ok(
    pieces.length > DEFAULT_OPTIONS.connections,
    `cần nhiều piece hơn số kết nối, nhận ${pieces.length}`,
  );
});

test('kích thước piece nằm trong khoảng đã định', () => {
  for (const size of [5 * MB, 100 * MB, 4096 * MB]) {
    for (const p of planPieces(size, DEFAULT_OPTIONS)) {
      const len = p.end - p.start + 1;
      assert.ok(len <= 16 * MB, `piece ${len} byte vượt trần 16MB`);
    }
  }
});

test('hàng chờ phát piece cho tới khi hết việc', () => {
  const pieces = planPieces(50 * MB, DEFAULT_OPTIONS);
  const taken = new Set<number>();
  for (;;) {
    const p = takeNextPending(pieces);
    if (!p) break;
    assert.ok(!taken.has(p.index), 'một piece bị phát hai lần');
    taken.add(p.index);
  }
  assert.equal(taken.size, pieces.length);
});

test('piece hết lượt thử thì bị đánh dấu thất bại thay vì quay vòng mãi', () => {
  const piece = planPieces(MB, DEFAULT_OPTIONS)[0]!;
  for (let i = 0; i < DEFAULT_OPTIONS.maxRetries; i++) {
    assert.equal(requeue(piece, DEFAULT_OPTIONS.maxRetries), true);
  }
  assert.equal(requeue(piece, DEFAULT_OPTIONS.maxRetries), false);
  assert.equal(piece.state, 'failed');
});

test('tổng byte nhận được cộng đúng qua các piece', () => {
  const pieces = planPieces(10 * MB, DEFAULT_OPTIONS);
  pieces.forEach((p, i) => (p.received = i * 100));
  const expected = pieces.reduce((s, _, i) => s + i * 100, 0);
  assert.equal(totalReceived(pieces), expected);
});

/* ---------- Tên file ---------- */

test('tên file không thể thoát khỏi thư mục tải', () => {
  assert.equal(sanitize('../../etc/passwd'), 'passwd');
  assert.equal(sanitize('/absolute/path/file.zip'), 'file.zip');
  assert.equal(sanitize('C:\\Windows\\evil.exe'), 'evil.exe');
});

test('ký tự cấm bị thay và tên rỗng có phương án dự phòng', () => {
  assert.equal(sanitize('a:b*c?.txt'), 'a_b_c_.txt');
  assert.equal(sanitize('   '), 'download');
  assert.equal(sanitize('...'), 'download');
});

test('tên dành riêng của Windows được đổi để không xung đột', () => {
  assert.equal(sanitize('CON'), '_CON');
  assert.equal(sanitize('lpt1.txt'), '_lpt1.txt');
});

test('Content-Disposition dạng RFC 5987 giữ được tiếng Việt', () => {
  const header = "attachment; filename*=UTF-8''b%C3%A1o%20c%C3%A1o.pdf";
  assert.equal(fromContentDisposition(header), 'báo cáo.pdf');
});

test('filename* được ưu tiên hơn filename thuần', () => {
  const header = "attachment; filename=\"fallback.bin\"; filename*=UTF-8''th%E1%BA%ADt.pdf";
  assert.equal(fromContentDisposition(header), 'thật.pdf');
});

test('filename có dấu nháy và khoảng trắng được đọc đúng', () => {
  assert.equal(fromContentDisposition('attachment; filename="my file.zip"'), 'my file.zip');
  assert.equal(fromContentDisposition('attachment; filename=plain.iso'), 'plain.iso');
  assert.equal(fromContentDisposition(null), null);
});

test('không có header thì lấy tên từ URL', () => {
  assert.equal(fromUrl('https://x.test/a/b/ubuntu.iso?v=1'), 'ubuntu.iso');
  assert.equal(fromUrl('https://x.test/'), 'x.test');
  assert.equal(fromUrl('https://x.test/t%E1%BB%87p.zip'), 'tệp.zip');
});

/* ---------- Probe ---------- */

interface FakeInit {
  status: number;
  headers?: Record<string, string>;
  url?: string;
}

function fakeResponse({ status, headers = {}, url = 'https://x.test/f.bin' }: FakeInit): Response {
  return {
    status,
    statusText: '',
    ok: status >= 200 && status < 300,
    url,
    headers: new Headers(headers),
    body: { cancel: async () => {} },
  } as unknown as Response;
}

function stubFetch(response: Response): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => response) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

test('206 kèm Content-Range cho biết kích thước và mở đường chia luồng', async () => {
  const restore = stubFetch(
    fakeResponse({
      status: 206,
      headers: { 'content-range': 'bytes 0-0/1048576', 'content-type': 'application/zip' },
    }),
  );
  try {
    const info = await probe('https://x.test/f.bin');
    assert.equal(info.size, 1048576);
    assert.equal(info.acceptRanges, true);
    assert.equal(info.mimeType, 'application/zip');
  } finally {
    restore();
  }
});

test('server phớt lờ Range và trả 200 thì lui về một luồng', async () => {
  const restore = stubFetch(
    fakeResponse({ status: 200, headers: { 'content-length': '5000000' } }),
  );
  try {
    const info = await probe('https://x.test/f.bin');
    assert.equal(info.size, 5000000);
    assert.equal(info.acceptRanges, false);
  } finally {
    restore();
  }
});

test('nội dung bị nén trên đường truyền thì cấm chia luồng vì offset sẽ lệch', async () => {
  const restore = stubFetch(
    fakeResponse({
      status: 206,
      headers: { 'content-range': 'bytes 0-0/900000', 'content-encoding': 'gzip' },
    }),
  );
  try {
    const info = await probe('https://x.test/f.bin');
    assert.equal(info.size, 900000);
    assert.equal(info.acceptRanges, false, 'gzip phải làm tắt chế độ nhiều luồng');
  } finally {
    restore();
  }
});

test('Content-Range dạng sao thì coi như không biết kích thước', async () => {
  const restore = stubFetch(
    fakeResponse({ status: 206, headers: { 'content-range': 'bytes 0-0/*' } }),
  );
  try {
    const info = await probe('https://x.test/f.bin');
    assert.equal(info.size, null);
    assert.equal(info.acceptRanges, false);
  } finally {
    restore();
  }
});

test('tên file lấy từ Content-Disposition của phản hồi thăm dò', async () => {
  const restore = stubFetch(
    fakeResponse({
      status: 206,
      headers: {
        'content-range': 'bytes 0-0/123',
        'content-disposition': 'attachment; filename="tai-lieu.pdf"',
      },
    }),
  );
  try {
    assert.equal((await probe('https://x.test/f.bin')).filename, 'tai-lieu.pdf');
  } finally {
    restore();
  }
});

test('URL cuối sau redirect được giữ lại để các piece dùng chung', async () => {
  const restore = stubFetch(
    fakeResponse({
      status: 206,
      headers: { 'content-range': 'bytes 0-0/123' },
      url: 'https://cdn.test/real/f.bin',
    }),
  );
  try {
    assert.equal((await probe('https://x.test/f.bin')).finalUrl, 'https://cdn.test/real/f.bin');
  } finally {
    restore();
  }
});

test('lỗi HTTP được báo ra thay vì nuốt lặng', async () => {
  const restore = stubFetch(fakeResponse({ status: 403 }));
  try {
    await assert.rejects(() => probe('https://x.test/f.bin'), /403/);
  } finally {
    restore();
  }
});
