import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { EngineRequest, EngineResponse } from '../src/shared/rpc';

/**
 * Race khởi động: trên Chromium, engine chạy trong offscreen document.
 * `ensureDocumentContext()` trả về ngay khi document tồnàng, nhưng listener
 * (`installEngineHost`) chỉ đăng ký SAU khi offscreen đọc cài đặt xong (~190ms).
 * Trong cửa sổ đó, `runtime.sendMessage({type:'engine:*'})` reject "Receiving end
 * does not exist" và `send()` chỉ `warn()` — lệnh mất hẳn. Nguy hiểm nhất là
 * `engine:add` từ `downloads.onCreated`: trình duyệt đã `cancel()`+`erase()` nên
 * file mất thật.
 *
 * Các test dưới đây mô phỏng race bằng cách stub `globalThis.chrome` TRƯỚC khi nạp
 * module `engine-channel` (esbuild bọc mỗi module trong lazy `__esm`, nên `api` chỉ
 * bind tới stub khi `createEngineChannel` được gọi lần đầu, sau khi stub đã sẵn
 * sàng). Mỗi test cài một `currentSend` riêng rồi tạo một channel mới.
 */

type SendFn = (req: EngineRequest) => Promise<EngineResponse | undefined>;

/**
 * Handler động: channel chỉ bind `api` một lần (lúc module nạp), nên ta không đổi
 * được `api.runtime.sendMessage` giữa các test. Thay vào đó, một hàm delegate trỏ
 * tới `currentSend` — gán lại `currentSend` mỗi test là đủ đổi hành vi.
 */
let currentSend: SendFn = async () => undefined;

const RACE_ERROR = 'Could not establish connection. Receiving end does not exist.';

// Cài stub MỘT LẦN ở phạm vi module (chạy khi bundle nạp, trước bất kỳ test nào
// gọi `createEngineChannel`). `offscreen.hasDocument` luôn true để
// `ensureDocumentContext()` nhanh chóng resolve (giả lập document đã tồn tại,
// chỉ listener là chưa đăng ký — đúng tình huống race thật).
(globalThis as { chrome?: unknown }).chrome = {
  runtime: {
    sendMessage: (req: EngineRequest): Promise<EngineResponse | undefined> => currentSend(req),
    getURL: (p: string): string => p,
    id: 'df-test',
  },
  offscreen: { hasDocument: async () => true },
};

let channelMod: typeof import('../src/shared/engine-channel') | null = null;
async function getChannel(): Promise<typeof import('../src/shared/engine-channel')> {
  if (!channelMod) channelMod = await import('../src/shared/engine-channel');
  return channelMod;
}

function add(url: string, source: 'auto' | 'manual' = 'auto'): EngineRequest {
  return { type: 'engine:add', url, source };
}

/* ---------- 1. Listener chưa sẵn sàng → xếp hàng, xả FIFO khi ping thành công ---------- */

test('listener chưa sẵn sàng thì xếp hàng rồi xả theo FIFO khi ping thành công', async () => {
  const delivered: EngineRequest[] = [];
  let pingAttempts = 0;
  let engineReady = false;
  currentSend = async (req) => {
    if (req.type === 'engine:ping') {
      pingAttempts += 1;
      // Giả lập cửa sổ ~190ms: hai ping đầu bị từ chối, ping thứ ba mới được.
      if (pingAttempts < 3) throw new Error(RACE_ERROR);
      engineReady = true;
      return { ok: true };
    }
    // engine:add: trước khi ready thì bị từ chối (race); sau khi ready thì vào engine.
    if (!engineReady) throw new Error(RACE_ERROR);
    delivered.push(req);
    return { ok: true };
  };

  const { createEngineChannel } = await getChannel();
  const channel = createEngineChannel({ pingIntervalMs: 5, pingTimeoutMs: 5000 });

  const a1 = add('https://a1');
  const a2 = add('https://a2');
  const a3 = add('https://a3');
  // Phát cả ba lệnh trong khi listener đang "chết". Không await giữa các lệnh:
  // phải xếp hàng cùng lúc, không lệnh nào bị mất.
  const p1 = channel.send(a1);
  const p2 = channel.send(a2);
  const p3 = channel.send(a3);

  await Promise.all([p1, p2, p3]);

  assert.equal(delivered.length, 3, 'cả ba lệnh phải tới được engine');
  assert.equal(delivered[0], a1, 'giữ thứ tự FIFO: a1 phải tới trước');
  assert.equal(delivered[1], a2);
  assert.equal(delivered[2], a3);
  assert.ok(pingAttempts >= 3, 'phải ping tới khi engine đáp lời');
});

/* ---------- 2. Listener sẵn sàng ngay → không xếp hàng, không ping ---------- */

test('listener sẵn sàng ngay thì gửi thẳng, không xếp hàng, không ping', async () => {
  const delivered: EngineRequest[] = [];
  let pingCalls = 0;
  currentSend = async (req) => {
    if (req.type === 'engine:ping') {
      pingCalls += 1;
      return { ok: true };
    }
    delivered.push(req);
    return { ok: true };
  };

  const { createEngineChannel } = await getChannel();
  const channel = createEngineChannel({ pingIntervalMs: 5, pingTimeoutMs: 5000 });

  const a = add('https://x', 'manual');
  await channel.send(a);

  assert.equal(delivered.length, 1, 'lệnh phải tới engine');
  assert.equal(delivered[0], a);
  assert.equal(pingCalls, 0, 'engine đã sẵn sàng thì không cần ping — gửi thẳng');
});

/* ---------- 3. Hết thời gian chờ → bỏ hàng đợi, cảnh báo ---------- */

test('hết thời gian chờ ping thì bỏ hàng đợi và cảnh báo, không kẹt lệnh mới', async () => {
  // Luôn từ chối: listener không bao giờ lên.
  currentSend = async () => {
    throw new Error(RACE_ERROR);
  };

  const warnCalls: unknown[][] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnCalls.push(args);
  };
  try {
    const { createEngineChannel } = await getChannel();
    const channel = createEngineChannel({ pingIntervalMs: 5, pingTimeoutMs: 80 });

    const a = add('https://x');
    const res = await channel.call(a);
    assert.equal(res, undefined, 'lệnh bị bỏ khi hết thời gian chờ phải trả undefined');
    assert.ok(warnCalls.length > 0, 'phải phát cảnh báo khi bỏ hàng đợi');
    assert.ok(
      warnCalls.some((c) => /ping|chờ|lệnh/i.test(c.map(String).join(' '))),
      'cảnh báo phải nói về ping/hết chờ/bỏ lệnh',
    );

    // Sau timeout, hàng đợi phải rỗng: lệnh mới phải đi thẳng (optimistic), không
    // kẹt phía sau lệnh cũ đã bỏ.
    const calls: EngineRequest[] = [];
    currentSend = async (req) => {
      calls.push(req);
      return { ok: true };
    };
    const a2 = add('https://y', 'manual');
    await channel.send(a2);
    assert.ok(calls.includes(a2), 'lệnh mới phải đi thẳng, chứng tỏ hàng đợi đã rỗng');
  } finally {
    console.warn = origWarn;
  }
});

/* ---------- 4. Đường Firefox (ghi chú) ---------- */

/**
 * Firefox không dùng offscreen document: engine chạy chung ngữ cảnh với event
 * page, và background `send()` đã `await localReady` trước khi dispatch trực tiếp
 * qua `dispatchEngineRequest`. UI trên Firefox mở sau khi event page đã lên sẵn,
 * nên listener đã đăng ký. Vì vậy không có race, không cần ping-gate.
 *
 * Không unit-test được đường này ở đây (cần build target=firefox và listener thật
 * trong cùng ngữ cảnh); nó được bảo đảm bởi nhánh `isFirefox` trong
 * `engine-channel.ts` đi thẳng không qua gate, giữ nguyên hành vi cũ. Phần kiểm
 * chứng thật thuộc về E2E.
 */
