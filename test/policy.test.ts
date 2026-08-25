import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  shouldIntercept,
  unfitForAcceleration,
  type InterceptCandidate,
  type InterceptContext,
} from '../src/engine/policy';

const MB = 1024 * 1024;
const MIN = 5 * MB;

/* ---------- Khi nào engine nên nhận việc ---------- */

test('file đủ lớn và server hỗ trợ Range thì nhận', () => {
  assert.equal(unfitForAcceleration(100 * MB, true, MIN), null);
});

test('server không hỗ trợ Range thì trả lại, vì chia luồng không được gì', () => {
  assert.match(unfitForAcceleration(100 * MB, false, MIN) ?? '', /khoảng byte/);
});

test('file nhỏ hơn ngưỡng thì trả lại', () => {
  assert.match(unfitForAcceleration(MB, true, MIN) ?? '', /quá nhỏ/);
});

test('không biết kích thước thì trả lại chứ không đoán mò', () => {
  assert.match(unfitForAcceleration(null, true, MIN) ?? '', /kích thước/);
});

test('đúng bằng ngưỡng thì vẫn nhận', () => {
  assert.equal(unfitForAcceleration(MIN, true, MIN), null);
});

/* ---------- Khi nào giành lượt tải của trình duyệt ---------- */

const ctx = (over: Partial<InterceptContext> = {}): InterceptContext => ({
  minSize: MIN,
  selfId: 'self-extension-id',
  handedBack: new Set<string>(),
  ...over,
});

const item = (over: Partial<InterceptCandidate> = {}): InterceptCandidate => ({
  url: 'https://x.test/big.iso',
  state: 'in_progress',
  fileSize: 100 * MB,
  ...over,
});

test('lượt tải http đủ lớn thì giành', () => {
  assert.equal(shouldIntercept(item(), ctx()), true);
});

test('chưa biết kích thước thì cứ giành, để engine tự đo', () => {
  assert.equal(shouldIntercept(item({ fileSize: -1 }), ctx()), true);
});

test('file nhỏ thì để trình duyệt lo', () => {
  assert.equal(shouldIntercept(item({ fileSize: MB }), ctx()), false);
});

test('blob URL không bao giờ bị giành — đó chính là file ta vừa bàn giao', () => {
  const blob = item({ url: 'blob:chrome-extension://abc/xyz' });
  assert.equal(shouldIntercept(blob, ctx()), false);
});

test('data URL cũng bị bỏ qua', () => {
  assert.equal(shouldIntercept(item({ url: 'data:text/plain,xin-chao' }), ctx()), false);
});

test('lượt tải do chính extension này tạo thì không giành, nếu không sẽ lặp vô tận', () => {
  const own = item({ byExtensionId: 'self-extension-id' });
  assert.equal(shouldIntercept(own, ctx()), false);
});

test('extension khác tạo lượt tải thì vẫn giành bình thường', () => {
  const other = item({ byExtensionId: 'some-other-extension' });
  assert.equal(shouldIntercept(other, ctx()), true);
});

test('URL vừa trả lại cho trình duyệt thì không giành lần nữa', () => {
  const handedBack = new Set(['https://x.test/big.iso']);
  assert.equal(shouldIntercept(item(), ctx({ handedBack })), false);
});

test('URL gốc nằm trong danh sách đã trả lại cũng được nhận ra sau redirect', () => {
  const redirected = item({
    url: 'https://x.test/big.iso',
    finalUrl: 'https://cdn.test/real.iso',
  });
  const handedBack = new Set(['https://x.test/big.iso']);
  assert.equal(shouldIntercept(redirected, ctx({ handedBack })), false);
});

test('lượt tải đã xong hoặc đứt thì không đụng vào', () => {
  assert.equal(shouldIntercept(item({ state: 'complete' }), ctx()), false);
  assert.equal(shouldIntercept(item({ state: 'interrupted' }), ctx()), false);
});

test('sau redirect thì xét theo URL cuối', () => {
  const viaHttp = item({ url: 'https://x.test/go', finalUrl: 'https://cdn.test/f.iso' });
  assert.equal(shouldIntercept(viaHttp, ctx()), true);
});
