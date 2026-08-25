#!/usr/bin/env node
// Engine viet bang TypeScript va nham vao browser, nen test duoc bundle sang
// ESM cho Node roi moi chay bang node:test.

import * as esbuild from 'esbuild';
import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outdir = path.join(root, 'dist', 'test');

const testDir = path.join(root, 'test');
const sources = (await readdir(testDir))
  .filter((f) => f.endsWith('.test.ts'))
  .map((f) => path.join(testDir, f));

await esbuild.build({
  entryPoints: sources,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: ['node20'],
  outdir,
  outExtension: { '.js': '.mjs' },
  packages: 'external',
  logLevel: 'warning',
});

// Liet ke tung file: truyen ca thu muc khien Node coi no la mot module don le.
const files = (await readdir(outdir))
  .filter((f) => f.endsWith('.test.mjs'))
  .map((f) => path.join(outdir, f));

if (files.length === 0) {
  console.error('Khong tim thay file test nao trong', outdir);
  process.exit(1);
}

const child = spawn(process.execPath, ['--test', ...files], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 1));
