#!/usr/bin/env node
/**
 * Khởi động Chromium thật, nạp extension Down Faster, gắn log.
 *
 * Dùng playwright-core (chỉ là driver, không tải browser) mở một persistent
 * context có cờ --load-extension trỏ vào dist/chromium. Extension MV3 chạy
 * service worker ở background và offscreen document; cả hai đều được gắn log
 * ra stdout để dò lỗi khi một checklist item thất bại.
 *
 * LƯU Ý QUAN TRỌNG VỀ PLAYWRIGHT + EXTENSION:
 *   Playwright mặc định thêm --disable-extensions, nên --load-extension bị
 *   vô hiệu hoá. PHẢI truyền `ignoreDefaultArgs: ['--disable-extensions',
 *   '--disable-component-extensions-with-background-pages']`. Đã kiểm chứng:
 *   service worker lên và `chrome.runtime.id` trả về đúng sau khi bỏ hai cờ
 *   đó. Thêm `--headless=new` để dùng headless mới (cũ hơn không nạp extension).
 *
 * Xuất:
 *   - findChromium()  : dò binary Chrome/Chromium
 *   - launch(tag, opts): { context, page, serviceWorker, cleanup }
 *   - waitForEngineReady(sw, timeoutMs): ping engine tới khi đáp {ok:true}
 */

import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

/** Quét ~/.cache/ms-playwright/chromium-* tìm chrome-linux64/chrome. */
function globPlaywrightChromium() {
  const cache = path.join(process.env.HOME ?? tmpdir(), '.cache', 'ms-playwright');
  if (!existsSync(cache)) return [];
  try {
    const out = [];
    for (const dir of readdirSync(cache)) {
      if (!dir.startsWith('chromium-') || dir.includes('headless')) continue;
      const bin = path.join(cache, dir, 'chrome-linux64', 'chrome');
      if (existsSync(bin)) out.push(bin);
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Tìm binary Chromium/Chrome để chạy.
 *
 * Thứ tự ưu tiên:
 *   1. biến môi trường CHROME_PATH (đường dẫn tuyệt đối)
 *   2. playwright-core.executablePath() — nhưng chỉ khi file thật sự tồn tại
 *      (playwright-core báo đường dẫn của build nó biết tới, không phải build đã
 *      cài; cài rồi gỡ là chuyện thường).
 *   3. các đường dẫn hệ thống phổ biến.
 *
 * @returns {Promise<string|null>} đường dẫn tuyệt đối tới binary, hoặc null.
 */
export async function findChromium() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }

  try {
    const pw = await import('playwright-core');
    const candidate = pw.chromium?.executablePath?.();
    if (candidate && existsSync(candidate)) return candidate;
  } catch {
    // playwright-core vắng — rơi xuống đường dẫn hệ thống.
  }

  const common = [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/opt/google/chrome/chrome',
    '/snap/bin/chromium',
    '/snap/bin/chromium-browser',
    // Build Playwright cài vào ~/.cache, có thể là chromium-XXXX.
    ...globPlaywrightChromium(),
  ];
  for (const p of common) {
    if (p && existsSync(p)) return p;
  }
  return null;
}

/**
 * Khởi động Chromium, nạp extension, gắn log.
 *
 * @param {string} [tag] - tiền tố log, vd "[e2e]"
 * @param {object} [opts]
 * @param {string} [opts.extensionPath] - mặc định dist/chromium
 * @param {string} [opts.userDataDir] - mặc định một tmpdir mới
 * @param {boolean} [opts.headless=true] - CI chạy headless; đặt false để gỡ lỗi
 * @param {string} [opts.executable] - đường dẫn binary (bỏ qua việc dò)
 * @returns {Promise<{context: any, page: any, serviceWorker: any, cleanup: () => Promise<void>}>}
 */
export async function launch(tag = '[e2e]', opts = {}) {
  const pwMod = await import('playwright-core');
  // playwright-core dưới ESM có thể bọc export trong `default`.
  const pw = pwMod.default ?? pwMod;
  const extensionPath = opts.extensionPath ?? path.join(ROOT, 'dist', 'chromium');
  if (!existsSync(path.join(extensionPath, 'manifest.json'))) {
    throw new Error(`Không tìm thấy manifest ở ${extensionPath}. Chạy: npm run build:dev`);
  }

  const executable = opts.executable ?? (await findChromium());
  if (!executable) {
    throw new Error(
      'Không tìm thấy Chromium. Cài: npx playwright install chromium, hoặc đặt CHROME_PATH=/path/to/chrome',
    );
  }

  const userDataDir = opts.userDataDir ?? mkdtempSync(path.join(tmpdir(), 'df-e2e-'));
  const headless = opts.headless ?? true;

  const context = await pw.chromium.launchPersistentContext(userDataDir, {
    headless,
    executablePath: executable,
    // Bắt buộc: Playwright thêm --disable-extensions mặc định, xoá sạch --load-extension.
    // Đã kiểm chứng: bỏ hai cờ này thì service worker của extension lên được.
    ignoreDefaultArgs: [
      '--disable-extensions',
      '--disable-component-extensions-with-background-pages',
    ],
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      // Headless mới (Chrome 109+) mới nạp được extension; headless cũ thì không.
      '--headless=new',
      // MV3 service worker cần cờ này để không bị Chromium dập tắt quá hời hợt.
      '--disable-features=DialMediaRouteProvider',
      '--no-first-run',
      '--no-default-browser-check',
      // Headless chạy root/CI thường cần; không hại gì khi không cần.
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
  });

  // Service worker là gốc của extension MV3: nó nhận engine:add, giành lượt tải,
  // và nhờ offscreen làm việc nặng. Bắt console của nó để dò lỗi.
  let serviceWorker = null;
  context.on('serviceworker', (worker) => {
    serviceWorker = worker;
    attachWorkerLogs(tag, 'SW', worker);
  });

  // Offscreen document chạy trong một page riêng (type=offscreen). Nó phát log
  // qua Page console event; engine host sống ở đây trên Chromium.
  context.on('page', (page) => {
    page.on('console', (msg) => {
      const loc = page.url();
      if (loc.startsWith('chrome-extension://') && loc.includes('offscreen')) {
        console.log(`${tag} [offscreen] ${msg.type()}: ${msg.text()}`);
      }
    });
    page.on('pageerror', (err) => {
      if (page.url().startsWith('chrome-extension://')) {
        console.log(`${tag} [offscreen-error] ${err.message}`);
      }
    });
  });

  // Chờ service worker lên: không có nó thì không gửi được engine:add. Có lúc
  // worker lên sẵn trước khi kịp bám listener, nên cố lấy qua context trước.
  await new Promise((r) => setTimeout(r, 2500));
  if (!serviceWorker) {
    try {
      serviceWorker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
      attachWorkerLogs(tag, 'SW', serviceWorker);
    } catch {
      const all = context.serviceWorkers();
      if (all.length > 0) {
        serviceWorker = all[0];
        attachWorkerLogs(tag, 'SW', serviceWorker);
      }
    }
  }

  if (!serviceWorker) {
    throw new Error('Service worker của extension không lên sau 17.5s.');
  }

  // Một trang rỗng để có ngữ cảnh page thông thường (content script, v.v.).
  let page = context.pages()[0];
  if (!page) {
    page = await context.newPage();
  }

  const cleanup = async () => {
    try {
      await context.close();
    } catch {
      // Đóng không sạch thì cũng bỏ qua — tiến trình kết thúc.
    }
  };

  return { context, page, serviceWorker, cleanup };
}

/**
 * Chờ engine (offscreen document) sẵn sàng nhận lệnh.
 *
 * Service worker lên nhanh, nhưng engine host nằm trong offscreen document và
 * đăng ký listener một cách bất đồng bộ. Gửi lệnh ngay thì gặp "Receiving end
 * does not exist" — đúng dấu hiệu race khởi động mà engine-channel mô tả. Thăm dò
 * `engine:ping` (không tác dụng phụ) tới khi đáp {ok:true}.
 *
 * @param {any} serviceWorker - worker lấy từ launch()
 * @param {number} [timeoutMs=30000] - thời gian chờ tối đa
 * @returns {Promise<boolean>} true khi engine đã đáp; false khi hết giờ.
 */
export async function waitForEngineReady(serviceWorker, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await serviceWorker.evaluate(async () => {
        try {
          return await chrome.runtime.sendMessage({ type: 'engine:ping' });
        } catch {
          return null;
        }
      });
      if (res && res.ok) return true;
    } catch {
      // Worker có thể đang khởi động lại; thử lại sau một nhịp.
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/** Gắn console + error của một Worker (service worker). */
function attachWorkerLogs(tag, label, worker) {
  worker.on('console', (msg) => {
    console.log(`${tag} [${label}] ${msg.type()}: ${msg.text()}`);
  });
  worker.on('weberror', (err) => {
    console.log(`${tag} [${label}-error] ${err.message}`);
  });
}
