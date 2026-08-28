#!/usr/bin/env node
// Dong goi hai target (chromium, firefox) thanh zip san sang dang store.
// Dung: npm run package
//
// Buoc:
//   1. Build ca hai target ra dist/chromium va dist/firefox (dung scripts/build.mjs).
//   2. Tao release/ (da .gitignore).
//   3. Zip noi dung dist/<target> (flat — manifest.json nam o goc zip).
//   4. Smoke check: kiem manifest.json co mat trong zip.
//
// Uu tien `zip` CLI neu co; neu khong thi bao loi ro rang.

import { execFileSync } from 'node:child_process';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseDir = path.join(root, 'release');

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { stdio: 'inherit', ...opts });
}

function shOut(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8' });
}

// 1. Doc version tu package.json de dat ten zip.
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;
if (!version) {
  console.error('Khong tim thay version trong package.json');
  process.exit(1);
}

// 2. Build ca hai target. Goi thang build.mjs (default: ca chromium + firefox).
console.log(`\n[package] build dist/chromium + dist/firefox (v${version})`);
sh(process.execPath, ['scripts/build.mjs'], { cwd: root });

// 3. Tao release/.
await mkdir(releaseDir, { recursive: true });

// 4. Kiem `zip` CLI co san hay khong.
const targets = ['chromium', 'firefox'];
const zips = {};
for (const target of targets) {
  const distDir = path.join(root, 'dist', target);
  if (!existsSync(distDir)) {
    console.error(`Khong tim thay ${distDir} — build co the da loi`);
    process.exit(1);
  }
  if (!existsSync(path.join(distDir, 'manifest.json'))) {
    console.error(`${distDir}/manifest.json khong co — build khong on`);
    process.exit(1);
  }
  const zipPath = path.join(releaseDir, `down-faster-${target}-${version}.zip`);
  zips[target] = zipPath;

  // zip -r <zip> .  : luu noi dung thu muc hien tai, giu cay con (icons/, _locales/).
  // Nhap tu stdin rong de zip khong doi stdin khi chay khong co terminal.
  console.log(`[package] zip ${path.relative(root, zipPath)}`);
  try {
    sh('zip', ['-r', '-q', zipPath, '.'], { cwd: distDir, input: '' });
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.error('Khong tim thay `zip` CLI. Cai Info-ZIP (apt install zip / brew install zip).');
      process.exit(1);
    }
    throw err;
  }
}

// 5. Smoke check: manifest.json phai nam trong zip + in kich thuoc.
console.log('\n[package] ket qua:');
let allOk = true;
for (const target of targets) {
  const zipPath = zips[target];
  const size = statSync(zipPath).size;
  const listing = shOut('unzip', ['-l', zipPath]);
  const hasManifest = listing
    .split('\n')
    .some((line) => line.trim().endsWith('manifest.json'));
  const ok = hasManifest ? 'OK' : 'THIEU manifest.json';
  if (!hasManifest) allOk = false;
  console.log(
    `  ${path.relative(root, zipPath)}  ${size} bytes  ${ok}`,
  );
}

if (!allOk) {
  console.error('\n[package] co zip thieu manifest.json — kiem lai build.');
  process.exit(1);
}
console.log('\n[package] xong.');
