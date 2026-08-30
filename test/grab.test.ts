import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyGrabUrl,
  dedupUrls,
  makeFileItem,
  makeMediaItem,
  makeErrorItem,
  GRAB_CONCURRENCY,
} from '../src/engine/grab';
import type { ProbeResult } from '../src/engine/types';
import type { MediaProbe, VariantSummary } from '../src/engine/hls';

/* ---------- classifyGrabUrl ---------- */

test('classifyGrabUrl nhận ra HLS .m3u8', () => {
  assert.equal(classifyGrabUrl('https://cdn.example/stream.m3u8'), 'media');
  assert.equal(classifyGrabUrl('https://cdn.example/playlist.m3u8?token=abc'), 'media');
});

test('classifyGrabUrl nhận ra HLS qua query param', () => {
  // Một số CDN dùng /stream?type=mpegurl
  assert.equal(classifyGrabUrl('https://cdn.example/stream?type=mpegurl'), 'media');
});

test('classifyGrabUrl nhận ra DASH .mpd là unsupported', () => {
  assert.equal(classifyGrabUrl('https://cdn.example/manifest.mpd'), 'unsupported');
});

test('classifyGrabUrl mặc định là file', () => {
  assert.equal(classifyGrabUrl('https://example.com/big.zip'), 'file');
  assert.equal(classifyGrabUrl('https://example.com/file.iso'), 'file');
  assert.equal(classifyGrabUrl('https://example.com/path/to/video.mp4'), 'file');
});

/* ---------- dedupUrls ---------- */

test('dedupUrls bỏ trùng URL giống nhau', () => {
  const result = dedupUrls([
    'https://example.com/file.zip',
    'https://example.com/file.zip',
    'https://example.com/file.zip',
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0], 'https://example.com/file.zip');
});

test('dedupUrls phân biệt URL khác nhau', () => {
  const result = dedupUrls([
    'https://example.com/a.zip',
    'https://example.com/b.zip',
    'https://example.com/c.zip',
  ]);
  assert.equal(result.length, 3);
});

test('dedupUrls bỏ trùng khi khác query params', () => {
  const result = dedupUrls([
    'https://example.com/file.zip?v=1',
    'https://example.com/file.zip?v=2',
  ]);
  // Query khác nhau = URL khác nhau, giữ cả.
  assert.equal(result.length, 2);
});

test('dedupUrls chuẩn hoá host lowercase + bỏ fragment', () => {
  const result = dedupUrls([
    'https://Example.COM/file.zip#section',
    'https://example.com/file.zip',
  ]);
  assert.equal(result.length, 1, 'fragment + case không tạo thêm entry');
});

test('dedupUrls bỏ dấu / cuối path', () => {
  const result = dedupUrls([
    'https://example.com/path/',
    'https://example.com/path',
  ]);
  assert.equal(result.length, 1);
});

test('dedupUrls bỏ dòng rỗng và khoảng trắng', () => {
  const result = dedupUrls([
    'https://example.com/a.zip',
    '',
    '   ',
    'https://example.com/b.zip',
  ]);
  assert.equal(result.length, 2);
});

test('dedupUrls giữ URL hỏng (sẽ báo lỗi khi probe)', () => {
  const result = dedupUrls(['not-a-url', 'also not valid']);
  assert.equal(result.length, 2);
});

test('dedupUrls giữ thứ tự gốc', () => {
  const result = dedupUrls([
    'https://c.example/3.zip',
    'https://a.example/1.zip',
    'https://b.example/2.zip',
  ]);
  assert.equal(result[0], 'https://c.example/3.zip');
  assert.equal(result[1], 'https://a.example/1.zip');
  assert.equal(result[2], 'https://b.example/2.zip');
});

/* ---------- makeFileItem ---------- */

test('makeFileItem dựng GrabbedItem file đúng', () => {
  const probe: ProbeResult = {
    finalUrl: 'https://cdn.example/big.zip',
    size: 10485760,
    acceptRanges: true,
    filename: 'big.zip',
    mimeType: 'application/zip',
    etag: '"abc"',
    lastModified: null,
  };
  const item = makeFileItem('https://cdn.example/big.zip', probe);
  assert.equal(item.kind, 'file');
  assert.equal(item.filename, 'big.zip');
  assert.equal(item.size, 10485760);
  assert.equal(item.url, 'https://cdn.example/big.zip');
  assert.equal(item.variants, undefined);
  assert.equal(item.error, undefined);
});

test('makeFileItem dùng finalUrl khi khác URL gốc', () => {
  const probe: ProbeResult = {
    finalUrl: 'https://cdn2.example/redirected.zip',
    size: 500,
    acceptRanges: false,
    filename: 'redirected.zip',
    mimeType: null,
    etag: null,
    lastModified: null,
  };
  const item = makeFileItem('https://example.com/redirect', probe);
  assert.equal(item.url, 'https://cdn2.example/redirected.zip');
  assert.equal(item.size, 500);
});

test('makeFileItem size null khi không biết', () => {
  const probe: ProbeResult = {
    finalUrl: 'https://example.com/stream',
    size: null,
    acceptRanges: false,
    filename: 'stream',
    mimeType: null,
    etag: null,
    lastModified: null,
  };
  const item = makeFileItem('https://example.com/stream', probe);
  assert.equal(item.size, null);
});

/* ---------- makeMediaItem ---------- */

test('makeMediaItem dựng GrabbedItem media đúng', () => {
  const variants: VariantSummary[] = [
    { uri: 'https://cdn.example/v720.m3u8', label: '1280×720 · 3,5 Mbps', bandwidth: 3500000, height: 720, hasSeparateAudio: false },
    { uri: 'https://cdn.example/v1080.m3u8', label: '1920×1080 · 6,2 Mbps', bandwidth: 6200000, height: 1080, hasSeparateAudio: true },
  ];
  const probe: MediaProbe = {
    kind: 'hls-master',
    url: 'https://cdn.example/master.m3u8',
    filename: 'master.mp4',
    variants,
    duration: 120,
    isLive: false,
    warnings: [],
    blocker: null,
  };
  const item = makeMediaItem('https://cdn.example/master.m3u8', probe);
  assert.equal(item.kind, 'media');
  assert.equal(item.filename, 'master.mp4');
  assert.equal(item.size, null, 'HLS không biết kích thước trước');
  assert.deepEqual(item.variants, variants);
  assert.equal(item.error, undefined);
});

test('makeMediaItem không có variants thì undefined', () => {
  const probe: MediaProbe = {
    kind: 'hls-media',
    url: 'https://cdn.example/playlist.m3u8',
    filename: 'playlist.ts',
    variants: [],
    duration: null,
    isLive: false,
    warnings: [],
    blocker: null,
  };
  const item = makeMediaItem('https://cdn.example/playlist.m3u8', probe);
  assert.equal(item.variants, undefined);
});

/* ---------- makeErrorItem ---------- */

test('makeErrorItem dựng GrabbedItem unsupported đúng', () => {
  const item = makeErrorItem('https://example.com/bad', 'Lỗi mạng');
  assert.equal(item.kind, 'unsupported');
  assert.equal(item.url, 'https://example.com/bad');
  assert.equal(item.error, 'Lỗi mạng');
  assert.equal(item.size, null);
  assert.equal(item.filename, '');
});

/* ---------- GRAB_CONCURRENCY ---------- */

test('GRAB_CONCURRENCY = 4 (không bắn quá nhiều probe cùng lúc)', () => {
  assert.equal(GRAB_CONCURRENCY, 4);
});
