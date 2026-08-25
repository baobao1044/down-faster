#!/usr/bin/env node
// Sinh icon PNG bang zlib co san cua Node, khong them thu vien do hoa nao.
// Ve o do phan giai gap 4 roi thu nho lai de canh muot.

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'src/icons');
mkdirSync(outDir, { recursive: true });

const BLUE = [37, 99, 235];
const WHITE = [255, 255, 255];
const SS = 4; // He so sieu lay mau.

/** Mau tai (x, y) trong khung [0,1]: nen tron xanh, mui ten trang xuong duoi. */
function sample(u, v) {
  const dx = u - 0.5;
  const dy = v - 0.5;
  if (dx * dx + dy * dy > 0.5 * 0.5) return null; // Ngoai hinh tron: trong suot.

  // Than mui ten.
  const inStem = Math.abs(dx) <= 0.09 && v >= 0.22 && v <= 0.58;
  // Dau mui ten: tam giac huong xuong.
  const headTop = 0.5;
  const headBottom = 0.78;
  const inHead =
    v >= headTop &&
    v <= headBottom &&
    Math.abs(dx) <= 0.26 * (1 - (v - headTop) / (headBottom - headTop));

  return inStem || inHead ? WHITE : BLUE;
}

function renderRGBA(size) {
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = sample((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size);
          if (c) { r += c[0]; g += c[1]; b += c[2]; a += 255; }
        }
      }
      const n = SS * SS;
      const i = (y * size + x) * 4;
      // Nhan mau theo do phu de vien khong bi vien toi.
      px[i] = a ? Math.round(r / (a / 255)) : 0;
      px[i + 1] = a ? Math.round(g / (a / 255)) : 0;
      px[i + 2] = a ? Math.round(b / (a / 255)) : 0;
      px[i + 3] = Math.round(a / n);
    }
  }
  return px;
}

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

function encodePNG(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  // Moi hang can mot byte filter dat truoc du lieu.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [16, 32, 48, 128]) {
  const file = path.join(outDir, `${size}.png`);
  writeFileSync(file, encodePNG(size, renderRGBA(size)));
  console.log(`  ${path.relative(root, file)}`);
}
console.log('Da sinh icon.');
