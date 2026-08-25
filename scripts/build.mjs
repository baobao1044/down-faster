#!/usr/bin/env node
// Build extension cho nhieu trinh duyet tu mot code base.
// Dung: node scripts/build.mjs [--target=chromium|firefox] [--watch] [--dev]

import * as esbuild from 'esbuild';
import { readFile, writeFile, mkdir, cp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name) => argv.some((a) => a === `--${name}`);
const opt = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];

const watch = flag('watch');
const dev = flag('dev') || watch;
const only = opt('target');
const TARGETS = only ? [only] : ['chromium', 'firefox'];

// Entry point dung chung. Worker phai la file rieng vi duoc nap qua new Worker(url).
const ENTRIES = {
  background: 'src/background/index.ts',
  manager: 'src/ui/manager.ts',
  popup: 'src/ui/popup.ts',
  welcome: 'src/ui/welcome.ts',
  'fetch-worker': 'src/engine/workers/fetch-worker.ts',
  'writer-worker': 'src/engine/workers/writer-worker.ts',
};

/** Content script: chạy trong trang web nên phải là bundle riêng, không phải module. */
const OPTIONAL_ENTRIES = {
  'media-detect': 'src/content/media-detect.ts',
};

// Chi Chromium co offscreen document; Firefox dung event page co san DOM.
const CHROMIUM_ONLY = { offscreen: 'src/offscreen/offscreen.ts' };

const STATIC = [
  ['src/ui/manager.html', 'manager.html'],
  ['src/ui/popup.html', 'popup.html'],
  ['src/ui/welcome.html', 'welcome.html'],
  ['src/ui/style.css', 'style.css'],
];
const CHROMIUM_STATIC = [['src/offscreen/offscreen.html', 'offscreen.html']];

async function buildManifest(target, outdir) {
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const base = JSON.parse(await readFile(path.join(root, 'manifest/base.json'), 'utf8'));
  const overlay = JSON.parse(
    await readFile(path.join(root, `manifest/${target}.json`), 'utf8'),
  );
  // Overlay ghi de nong: mang nhu "permissions" duoc thay the han, khong tron.
  const manifest = { ...base, ...overlay, version: pkg.version };
  await writeFile(
    path.join(outdir, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
  );
}

async function copyStatic(target, outdir) {
  const files = target === 'chromium' ? [...STATIC, ...CHROMIUM_STATIC] : STATIC;
  for (const [from, to] of files) {
    const src = path.join(root, from);
    if (!existsSync(src)) continue;
    await cp(src, path.join(outdir, to));
  }
  const icons = path.join(root, 'src/icons');
  if (existsSync(icons)) await cp(icons, path.join(outdir, 'icons'), { recursive: true });

  // Bản dịch nằm ở gốc dự án theo đúng bố cục mà trình duyệt yêu cầu.
  const locales = path.join(root, '_locales');
  if (existsSync(locales)) {
    await cp(locales, path.join(outdir, '_locales'), { recursive: true });
  }
}

async function buildTarget(target) {
  const outdir = path.join(root, 'dist', target);
  await rm(outdir, { recursive: true, force: true });
  await mkdir(outdir, { recursive: true });

  const entryPoints = {
    ...ENTRIES,
    ...(target === 'chromium' ? CHROMIUM_ONLY : {}),
    ...Object.fromEntries(
      Object.entries(OPTIONAL_ENTRIES).filter(([, file]) =>
        existsSync(path.join(root, file)),
      ),
    ),
  };

  const options = {
    entryPoints: Object.fromEntries(
      Object.entries(entryPoints).map(([name, file]) => [name, path.join(root, file)]),
    ),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: target === 'chromium' ? ['chrome116'] : ['firefox128'],
    outdir,
    define: {
      __TARGET__: JSON.stringify(target),
      __DEV__: JSON.stringify(dev),
    },
    sourcemap: dev ? 'inline' : false,
    minify: !dev,
    logLevel: 'info',
  };

  const finish = async () => {
    await buildManifest(target, outdir);
    await copyStatic(target, outdir);
  };

  if (watch) {
    const ctx = await esbuild.context({
      ...options,
      plugins: [
        {
          name: 'assets',
          setup(build) {
            build.onEnd(() => finish());
          },
        },
      ],
    });
    await ctx.watch();
    console.log(`[watch] ${target} -> dist/${target}`);
  } else {
    await esbuild.build(options);
    await finish();
    console.log(`[build] ${target} -> dist/${target}`);
  }
}

for (const t of TARGETS) {
  if (!existsSync(path.join(root, `manifest/${t}.json`))) {
    console.error(`Khong tim thay manifest/${t}.json`);
    process.exit(1);
  }
  await buildTarget(t);
}
