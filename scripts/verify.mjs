#!/usr/bin/env node
/**
 * Kiem tra file tai ve co dung tung byte khong.
 *
 * Server test sinh du lieu theo byte[i] = i % 251. Neu mot piece ghi lech offset,
 * hoac hai piece chong len nhau, cho sai se lo ra ngay o day.
 *
 * Dung: node scripts/verify.mjs <duong-dan-file>
 */

import { open, stat } from 'node:fs/promises';

const PERIOD = 251;
const file = process.argv[2];

if (!file) {
  console.error('Dung: node scripts/verify.mjs <duong-dan-file>');
  process.exit(2);
}

const info = await stat(file);
const handle = await open(file, 'r');
const buf = Buffer.allocUnsafe(1024 * 1024);

let offset = 0;
let bad = 0;
const samples = [];

try {
  for (;;) {
    const { bytesRead } = await handle.read(buf, 0, buf.length, offset);
    if (bytesRead === 0) break;

    for (let i = 0; i < bytesRead; i++) {
      const expected = (offset + i) % PERIOD;
      if (buf[i] !== expected) {
        bad += 1;
        if (samples.length < 5) {
          samples.push({ at: offset + i, got: buf[i], want: expected });
        }
      }
    }
    offset += bytesRead;
  }
} finally {
  await handle.close();
}

console.log(`File:     ${file}`);
console.log(`Kich thuoc: ${info.size.toLocaleString('vi-VN')} byte`);

if (bad === 0) {
  console.log('Ket qua:  DUNG TOAN BO — moi byte khop mau du lieu');
  process.exit(0);
}

console.log(`Ket qua:  SAI ${bad.toLocaleString('vi-VN')} byte`);
for (const s of samples) {
  console.log(`  offset ${s.at}: nhan ${s.got}, can ${s.want}`);
}
process.exit(1);
