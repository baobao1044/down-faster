#!/usr/bin/env node
/**
 * Chạy danh sách kiểm chứng (checklist) đối với server test.
 *
 * Mỗi item: gửi `engine:add` (source 'manual' để ép engine xử lý mọi route,
 * kể cả gzip/norange mà chế độ auto vốn trả lại trình duyệt), thăm dò `engine:list`
 * tới khi state chốt, rồi kiểm byte-exact file tải về với công thức byte[i] = i % 251
 * (cùng mẫu mà scripts/verify.mjs dùng).
 *
 * Tham số:
 *   --port=PORT        cổng test server (mặc định 8787)
 *   --browser=PATH     binary Chrome/Chromium (bỏ qua dò)
 *   --headed           chạy có cửa sổ (gỡ lỗi)
 *   --timeout=MS       thời gian chờ mỗi item (mặc định 60000)
 *
 * Xuất ra stdout một JSON kết quả (run.mjs mới ghi file).
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { launch, findChromium, waitForEngineReady } from './launch.mjs';

const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1];
const flag = (n) => process.argv.includes(`--${n}`);
const port = Number(arg('port') ?? 8787);
const browserArg = arg('browser');
const headless = !flag('headed');
const itemTimeout = Number(arg('timeout') ?? 60_000);

const base = `http://localhost:${port}`;
const MB = 1024 * 1024;

/** Kiểm byte-exact theo byte[i] = i % 251 (cùng mẫu scripts/verify.mjs dùng). */
async function verifyPattern(filePath, expectedSize) {
  const fsp = await import('node:fs/promises');
  if (!existsSync(filePath)) return { ok: false, bad: 0, size: 0, reason: 'file không tồn tại' };
  let st;
  try { st = statSync(filePath); } catch { return { ok: false, bad: 0, size: 0, reason: 'stat lỗi' }; }
  if (expectedSize != null && st.size !== expectedSize) {
    return { ok: false, bad: 0, size: st.size, reason: `sai kích thước: ${st.size} ≠ ${expectedSize}` };
  }
  const PERIOD = 251;
  const handle = await fsp.open(filePath, 'r');
  const buf = Buffer.allocUnsafe(1024 * 1024);
  let offset = 0;
  let bad = 0;
  try {
    for (;;) {
      const { bytesRead } = await handle.read(buf, 0, buf.length, offset);
      if (bytesRead === 0) break;
      for (let i = 0; i < bytesRead; i++) {
        if (buf[i] !== (offset + i) % PERIOD) bad += 1;
      }
      offset += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return { ok: bad === 0, bad, size: st.size };
}

/**
 * Tìm file vừa tải về trong thư mục Downloads của người dùng.
 * Engine gọi chrome.downloads.download({filename}), file ghi vào thư mục tải
 * mặc định của hồ sơ. Trả đường dẫn đầu tiên khớp tên, hoặc null.
 */
function findDownloaded(filename) {
  const dirs = [
    path.join(process.env.HOME ?? '', 'Downloads'),
    path.join(process.env.HOME ?? '', 'Tải xuống'),
    path.join(process.env.HOME ?? '', 'T\u1EA3i xu\u1ED1ng'),
  ];
  for (const d of dirs) {
    if (!existsSync(d)) continue;
    try {
      for (const f of readdirSync(d)) {
        if (f === filename) return path.join(d, f);
      }
    } catch {
      // bỏ qua thư mục không đọc được
    }
  }
  return null;
}

/**
 * Gửi engine:add manual, thăm dò engine:list tới khi state chốt, trả task cuối.
 * @param {any} sw - service worker
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<{task: object|null, addError: string|null}>}
 */
async function addAndPoll(sw, url, timeoutMs) {
  let addError = null;
  try {
    const add = await sw.evaluate(async (u) => {
      try { return await chrome.runtime.sendMessage({ type: 'engine:add', url: u, source: 'manual' }); }
      catch (e) { return { error: String(e) }; }
    }, url);
    if (add && add.error) addError = add.error;
    else if (!add || !add.ok) addError = add ? JSON.stringify(add) : 'không có đáp';
  } catch (e) {
    addError = String(e);
  }
  if (addError) return { task: null, addError };

  const deadline = Date.now() + timeoutMs;
  let task = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const list = await sw.evaluate(async () => {
        try { return await chrome.runtime.sendMessage({ type: 'engine:list' }); }
        catch (e) { return { error: String(e).slice(0, 60) }; }
      });
      const tasks = list?.tasks ?? [];
      if (tasks.length > 0) {
        // Lấy task mới nhất (createdAt giảm dần theo list()).
        task = tasks[0];
        if (['completed', 'failed', 'canceled'].includes(task.state)) break;
      }
    } catch {
      // thử lại
    }
  }
  return { task, addError: null };
}

/** Định nghĩa các checklist item. Mỗi item trả về {name, passed, detail, bytes}.
 *
 * Tên file: server không gửi Content-Disposition (trừ /named), nên engine rút
 * tên từ URL — chính là segment cuối, tức số byte (vd /file/1048576 → "1048576").
 * `/named` gửi Content-Disposition tiếng Việt nên tên là "báo cáo thử.bin".
 */
function buildItems() {
  return [
    {
      id: 1,
      name: 'file thường, 8 luồng, Range đầy đủ (1 MiB)',
      url: `${base}/file/${MB}`,
      size: MB,
      filename: String(MB),
    },
    {
      id: 2,
      name: 'file lớn chia luồng, byte-exact (4 MiB)',
      url: `${base}/file/${4 * MB}`,
      size: 4 * MB,
      filename: String(4 * MB),
    },
    {
      id: 3,
      name: '/slow bóp tốc độ từng kết nối, vẫn đúng byte (1 MiB, 200 KB/s)',
      url: `${base}/slow/${MB}?kbps=200`,
      size: MB,
      filename: String(MB),
    },
    {
      id: 4,
      name: '/norange không hỗ trợ Range, lui về 1 luồng (1 MiB)',
      url: `${base}/norange/${MB}`,
      size: MB,
      filename: String(MB),
    },
    {
      id: 5,
      name: '/gzip nén trên đường, cấm chia luồng, byte-exact (1 MiB)',
      url: `${base}/gzip/${MB}`,
      size: MB,
      filename: String(MB),
    },
    {
      id: 8,
      name: '/flaky đứt giữa chừng, đường retry, đúng byte (1 MiB, drop=512KB)',
      url: `${base}/flaky/${MB}?drop=524288`,
      size: MB,
      filename: String(MB),
    },
    {
      id: 9,
      name: 'tải song song hai file cùng lúc (2 × /file, 1 MiB và 2 MiB)',
      parallel: true,
      children: [
        { url: `${base}/file/${MB}`, size: MB, filename: String(MB) },
        { url: `${base}/file/${2 * MB}`, size: 2 * MB, filename: String(2 * MB) },
      ],
    },
    {
      id: 10,
      name: '/named Content-Disposition tên tiếng Việt (1 MiB)',
      url: `${base}/named/${MB}`,
      size: MB,
      filename: 'báo cáo thử.bin',
    },
  ];
}

async function runItem(sw, item) {
  const started = Date.now();
  // item song song
  if (item.parallel) {
    const results = await Promise.all(
      item.children.map(async (c) => {
        const r = await addAndPoll(sw, c.url, itemTimeout);
        return { url: c.url, ...r, expectedSize: c.size, filename: c.filename };
      }),
    );
    const allCompleted = results.every((r) => r.task?.state === 'completed');
    const bytes = results.reduce((s, r) => s + (r.task?.received ?? 0), 0);
    // Kiểm byte cho từng file
    const verifications = [];
    for (const r of results) {
      const f = findDownloaded(r.filename);
      const v = f ? await verifyPattern(f, r.expectedSize) : { ok: false, reason: 'file không thấy' };
      verifications.push({ filename: r.filename, ...v });
    }
    const passed = allCompleted && verifications.every((v) => v.ok);
    return {
      id: item.id,
      name: item.name,
      passed,
      ms: Date.now() - started,
      bytes,
      detail: results.map((r, i) => ({
        url: r.url,
        state: r.task?.state ?? 'unknown',
        addError: r.addError,
        verify: verifications[i],
      })),
    };
  }

  // item đơn
  const { task, addError } = await addAndPoll(sw, item.url, itemTimeout);
  const state = task?.state ?? 'unknown';
  if (addError || !task) {
    return { id: item.id, name: item.name, passed: false, ms: Date.now() - started, bytes: 0, detail: { addError, state } };
  }
  const bytes = task.received ?? 0;
  // Chờ trình duyệt ghi file xong một nhịp.
  await new Promise((r) => setTimeout(r, 1200));
  const file = findDownloaded(item.filename);
  const verify = file ? await verifyPattern(file, item.size) : { ok: false, reason: 'file không thấy trong Downloads' };
  const passed = state === 'completed' && verify.ok;
  return {
    id: item.id,
    name: item.name,
    passed,
    ms: Date.now() - started,
    bytes,
    detail: { url: item.url, state, received: task.received, size: task.size, filename: task.filename, error: task.error, verify, foundPath: file },
  };
}

export async function runChecklist(opts = {}) {
  const executable = opts.executable ?? browserArg ?? (await findChromium());
  if (!executable) {
    return {
      ok: false,
      error: 'Không tìm thấy Chromium. Cài: npx playwright install chromium, hoặc đặt CHROME_PATH=/path/to/chrome',
    };
  }

  console.error('[e2e] khởi động Chromium...');
  const { serviceWorker: sw, cleanup } = await launch('[e2e]', { executable, headless });

  console.error('[e2e] chờ engine sẵn sàng (ping)...');
  const ready = await waitForEngineReady(sw, 30_000);
  if (!ready) {
    await cleanup();
    return {
      ok: false,
      error:
        'Engine (offscreen document) không đáp engine:ping sau 30s. ' +
        'Có thể offscreen document không tạo được trong môi trường này ' +
        '(chrome.offscreen.createDocument hay thất bại dưới headless). ' +
        'Thử --headed, hoặc chạy trên máy có GUI.',
    };
  }
  console.error('[e2e] engine sẵn sàng.');

  const items = buildItems();
  const results = [];
  for (const item of items) {
    console.error(`[e2e] chạy item ${item.id}: ${item.name}`);
    const r = await runItem(sw, item);
    results.push(r);
    console.error(`[e2e]   → ${r.passed ? 'ĐẠT' : 'KHÔNG ĐẠT'} (${r.ms}ms)`);
  }

  await cleanup();
  const passed = results.filter((r) => r.passed).length;
  return { ok: true, total: results.length, passed, results };
}

// Chạy trực tiếp khi gọi node scripts/e2e/checklist.mjs.
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const out = await runChecklist();
    console.log(JSON.stringify(out, null, 2));
    process.exit(out.ok && out.passed === out.total ? 0 : 1);
  } catch (err) {
    console.error('[e2e] LỖI:', err);
    console.log(JSON.stringify({ ok: false, error: String(err) }, null, 2));
    process.exit(1);
  }
}
