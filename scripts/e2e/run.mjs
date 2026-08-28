#!/usr/bin/env node
/**
 * Điểm vào của bộ E2E: `npm run e2e`.
 *
 * Trình tự:
 *   1. Nếu dist/chromium/manifest.json thiếu → dựng bản dev (npm run build:dev).
 *   2. Dò binary Chromium/Chrome; không thấy → in hướng dẫn rồi thoát 1.
 *   3. Bật scripts/testserver.mjs ở nền (nếu cổng chưa có ai chiếm).
 *   4. Chạy checklist (scripts/e2e/checklist.mjs), gom kết quả.
 *   5. Ghi dist/e2e-results.json và in bảng tóm tắt.
 *   6. Tắt testserver nếu chính mình đã bật.
 *
 * Lưu ý: bộ E2E tải file THẬT qua HTTP và ghi vào thư mục Downloads của người
 * dùng, nên cần một Chromium/Chrome thật (không phải headless shell thuần).
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { findChromium } from './launch.mjs';
import { runChecklist } from './checklist.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const arg = (n) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1];
const flag = (n) => process.argv.includes(`--${n}`);
const port = Number(arg('port') ?? 8787);
const headless = !flag('headed');
const browserArg = arg('browser');

function log(msg) {
  console.error(`[e2e:run] ${msg}`);
}

/** Kiểm xem có server nào đang nghe ở cổng này chưa. */
async function isPortInUse(p) {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${p}/stats`, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1500, () => { req.destroy(); resolve(false); });
  });
}

/** Bật testserver ở nền. Trả { child, stop } hoặc null nếu bật không lên. */
function startTestserver(p) {
  const serverPath = path.join(ROOT, 'scripts', 'testserver.mjs');
  const child = spawn(process.execPath, [serverPath, `--port=${p}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let buf = '';
  child.stdout.on('data', (d) => { buf += d; });
  child.stderr.on('data', (d) => { buf += d; });
  const stop = () => { try { child.kill('SIGTERM'); } catch {} };
  return { child, stop, getLog: () => buf };
}

/** Chờ server lên (thăm dò /stats) tới tối đa 30s. */
async function waitForServer(p) {
  for (let i = 0; i < 30; i++) {
    if (await isPortInUse(p)) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

/** Dựng bản dev nếu dist/chromium thiếu. */
async function ensureBuild() {
  const manifest = path.join(ROOT, 'dist', 'chromium', 'manifest.json');
  if (existsSync(manifest)) return;
  log('dist/chromium chưa có, dựng bản dev...');
  const ok = await new Promise((resolve) => {
    const child = spawn('npm', ['run', 'build:dev'], { cwd: ROOT, stdio: 'inherit' });
    child.on('exit', (code) => resolve(code === 0));
  });
  if (!ok || !existsSync(manifest)) {
    throw new Error('Dựng bản dev thất bại. Chạy tay: npm run build:dev');
  }
  log('đã dựng xong.');
}

async function main() {
  // 1. Dựng nếu thiếu
  await ensureBuild();

  // 2. Dò browser
  const executable = browserArg ?? (await findChromium());
  if (!executable) {
    console.error('Không tìm thấy Chromium. Cài: npx playwright install chromium, hoặc đặt CHROME_PATH=/path/to/chrome');
    process.exit(1);
  }
  log(`dùng browser: ${executable}`);

  // 3. Bật testserver nếu chưa có
  let serverHandle = null;
  if (await isPortInUse(port)) {
    log(`cổng ${port} đã có server, dùng luôn.`);
  } else {
    log(`bật testserver ở cổng ${port}...`);
    serverHandle = startTestserver(port);
    const up = await waitForServer(port);
    if (!up) {
      console.error('Server test không lên sau 30s. Log:');
      console.error(serverHandle.getLog());
      serverHandle.stop();
      process.exit(1);
    }
    log('server test đã lên.');
  }

  // 4. Chạy checklist
  let result;
  try {
    result = await runChecklist({ executable, headless });
  } finally {
    // 6. Tắt server nếu mình bật
    if (serverHandle) {
      log('tắt testserver.');
      serverHandle.stop();
    }
  }

  // 5. Ghi kết quả + in tóm tắt
  const outDir = path.join(ROOT, 'dist');
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'e2e-results.json');
  const payload = { timestamp: new Date().toISOString(), port, browser: executable, ...result };
  writeFileSync(outFile, JSON.stringify(payload, null, 2) + '\n');
  log(`kết quả ghi vào ${outFile}`);

  // Bảng tóm tắt
  console.log('');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Kết quả E2E Down Faster');
  console.log('═══════════════════════════════════════════════════════════════');
  if (!result.ok) {
    console.log(`  LỖI: ${result.error}`);
    console.log('═══════════════════════════════════════════════════════════════');
    process.exit(1);
  }
  const rows = result.results ?? [];
  for (const r of rows) {
    const mark = r.passed ? '✓' : '✗';
    console.log(`  ${mark} #${r.id}  ${r.name}  (${r.ms}ms)`);
    if (!r.passed && r.detail) {
      const d = typeof r.detail === 'string' ? r.detail : JSON.stringify(r.detail);
      console.log(`        ${d.slice(0, 200)}`);
    }
  }
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Đạt ${result.passed}/${result.total}`);
  console.log('═══════════════════════════════════════════════════════════════');

  process.exit(result.passed === result.total ? 0 : 1);
}

main().catch((err) => {
  console.error('[e2e:run] LỖI KHÔNG MONG ĐỢI:', err);
  process.exit(1);
});
