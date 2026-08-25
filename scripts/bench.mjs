#!/usr/bin/env node
// Bundle bench sang ESM cho Node roi chay, giong cach scripts/test.mjs lam.

import * as esbuild from 'esbuild';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outfile = path.join(root, 'dist', 'bench.mjs');

await esbuild.build({
  entryPoints: [path.join(root, 'bench', 'bench.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: ['node20'],
  outfile,
  packages: 'external',
  logLevel: 'warning',
});

const child = spawn(process.execPath, [outfile, ...process.argv.slice(2)], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 1));
