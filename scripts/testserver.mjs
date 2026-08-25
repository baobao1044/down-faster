#!/usr/bin/env node
/**
 * Server thu de kiem chung engine.
 *
 * Du lieu duoc sinh theo cong thuc byte[i] = i % 251, khong doc tu dia. Nho vay
 * file tai ve co the kiem tra tung byte: chi can mot piece ghi lech offset la
 * scripts/verify.mjs phat hien ngay.
 *
 * Dung: node scripts/testserver.mjs [--port=8787]
 */

import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { once } from 'node:events';

const PORT = Number(
  process.argv.find((a) => a.startsWith('--port='))?.split('=')[1] ?? 8787,
);

const PERIOD = 251; // So nguyen to: lech offset bat ky deu lo ra.
const CHUNK = 64 * 1024;

/** Sinh du lieu cho khoang [start, start+len). */
function patternBuffer(start, len) {
  const buf = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) buf[i] = (start + i) % PERIOD;
  return buf;
}

/* ---------- Theo doi so ket noi dong thoi ---------- */

let active = 0;
let peak = 0;
let totalRequests = 0;

function trackOpen(label) {
  active += 1;
  totalRequests += 1;
  if (active > peak) {
    peak = active;
    console.log(`  dinh moi: ${peak} ket noi song song`);
  }
  return label;
}

function trackClose() {
  active = Math.max(0, active - 1);
}

/* ---------- Phan tich header Range ---------- */

function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;

  const [, rawStart, rawEnd] = m;
  let start;
  let end;

  if (rawStart === '') {
    // Dang "bytes=-500": 500 byte cuoi.
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Number(rawEnd);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start > end || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

/* ---------- Gui du lieu, co the bop toc do ---------- */

async function sendPattern(res, start, end, kbps, dropAt) {
  for (let off = start; off <= end; off += CHUNK) {
    const len = Math.min(CHUNK, end - off + 1);

    // Mo phong dut ket noi giua chung de thu duong retry.
    if (dropAt && off - start >= dropAt) {
      res.destroy();
      return;
    }

    if (!res.write(patternBuffer(off, len))) {
      await once(res, 'drain').catch(() => {});
    }
    if (kbps > 0) await sleep((len / (kbps * 1024)) * 1000);
  }
  res.end();
}

/* ---------- Dinh tuyen ---------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const parts = url.pathname.split('/').filter(Boolean);
  const mode = parts[0] ?? '';
  const size = Number(parts[1] ?? 0);

  if (mode === 'stats') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ active, peak, totalRequests }));
    return;
  }

  if (!size || !Number.isFinite(size)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(
      [
        'Server test cua Down Faster',
        '',
        `  /file/<bytes>              ho tro Range day du`,
        `  /slow/<bytes>?kbps=200     bop toc do TUNG ket noi (thay ro tang toc)`,
        `  /norange/<bytes>           khong ho tro Range, engine phai lui ve 1 luong`,
        `  /gzip/<bytes>              nen tren duong truyen, phai tat chia luong`,
        `  /named/<bytes>             Content-Disposition ten tieng Viet`,
        `  /flaky/<bytes>?drop=1048576  dut ket noi giua chung, thu duong retry`,
        `  /stats                     so ket noi dong thoi`,
        '',
        `Vi du: http://localhost:${PORT}/slow/104857600?kbps=200`,
      ].join('\n'),
    );
    return;
  }

  const kbps = Number(url.searchParams.get('kbps') ?? 0);
  const dropAt = Number(url.searchParams.get('drop') ?? 0);

  trackOpen(mode);
  res.on('close', trackClose);

  // Khong ho tro Range: luon tra ca file.
  if (mode === 'norange') {
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': String(size),
      'accept-ranges': 'none',
    });
    await sendPattern(res, 0, size - 1, kbps, 0);
    return;
  }

  // Nen tren duong truyen: engine phai tu tat chia luong.
  if (mode === 'gzip') {
    const { gzipSync } = await import('node:zlib');
    const body = gzipSync(patternBuffer(0, size));
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-encoding': 'gzip',
      'content-length': String(body.length),
      'accept-ranges': 'bytes',
    });
    res.end(body);
    return;
  }

  const range = parseRange(req.headers.range, size);
  const headers = {
    'content-type': 'application/octet-stream',
    'accept-ranges': 'bytes',
    etag: `"pattern-${size}"`,
  };
  if (mode === 'named') {
    headers['content-disposition'] =
      "attachment; filename*=UTF-8''b%C3%A1o%20c%C3%A1o%20th%E1%BB%AD.bin";
  }

  if (req.method === 'HEAD') {
    res.writeHead(200, { ...headers, 'content-length': String(size) });
    res.end();
    return;
  }

  if (!range) {
    res.writeHead(200, { ...headers, 'content-length': String(size) });
    await sendPattern(res, 0, size - 1, kbps, mode === 'flaky' ? dropAt : 0);
    return;
  }

  res.writeHead(206, {
    ...headers,
    'content-length': String(range.end - range.start + 1),
    'content-range': `bytes ${range.start}-${range.end}/${size}`,
  });
  await sendPattern(res, range.start, range.end, kbps, mode === 'flaky' ? dropAt : 0);
});

server.listen(PORT, () => {
  console.log(`Server test dang chay tai http://localhost:${PORT}`);
  console.log(`Mo http://localhost:${PORT}/ de xem danh sach endpoint`);
  console.log('');
});
