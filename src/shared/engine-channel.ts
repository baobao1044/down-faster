import type { EngineRequest, EngineResponse } from './rpc';
import { api, ensureDocumentContext, isChromium, isFirefox } from '../platform/api';
import { warn } from './log';

/**
 * Cửa chặn engine: chờ engine (trong offscreen document trên Chromium, hoặc
 * localReady trên Firefox) sẵn sàng nhận lệnh trước khi gửi. Mọi lệnh phát sinh
 * trong lúc chờ được xếp hàng FIFO và xả khi ack đầu tiên tới.
 *
 * Lỗi thật: ensureDocumentContext() trả về khi document tồn tại, chưa chắc
 * listener đã đăng ký (~190ms). Gửi trong cửa sổ đó thì mất hẳn — đặc biệt nguy
 * hiểm với engine:add từ downloads.onCreated, vì bản trình duyệt đã bị cancel().
 *
 * Cách sửa: gửi thử lệnh thật trước (optimistic). Nếu engine đã lên thì đi thẳng,
 * khỏi xếp hàng, khỏi ping. Nếu bị từ chối dạng "Receiving end does not exist"
 * (đúng dấu hiệu race) thì xếp lệnh đó vào đầu hàng, rồi thăm dò engine:ping
 * (không tác dụng phụ) cho tới khi {ok:true} hoặc hết giờ; khi xong thì xả FIFO.
 * Hết giờ thì bỏ hàng (warn), không kẹt lệnh mãi — lệnh sau được thử lại từ đầu.
 */

export interface EngineChannel {
  /** Phát lệnh và chờ tới khi thật sự gửi xong (đã xả qua gate nếu cần). */
  send(request: EngineRequest): Promise<void>;
  /** Như send nhưng trả lời đáp của engine (cho UI); undefined khi thất bại. */
  call(request: EngineRequest): Promise<EngineResponse | undefined>;
}

export interface EngineChannelOptions {
  /**
   * Bỏ qua ping-gate và gọi thẳng. Dùng trên Firefox background, nơi engine chạy
   * cùng ngữ cảnh: `dispatchEngineRequest(await localReady, request, () => {})`.
   */
  directDispatch?: (request: EngineRequest) => Promise<EngineResponse | undefined>;
  /** Khoảng giữa các lần thăm dò ping (mặc định 50ms). */
  pingIntervalMs?: number;
  /** Thời gian chờ ping tối đa trước khi bỏ hàng (mặc định 2000ms). */
  pingTimeoutMs?: number;
}

/** Dấu hiệu race: không có listener nhận — khác với lỗi xử lý thật của engine. */
function isRaceError(err: unknown): boolean {
  return /Receiving end does not exist|Could not establish connection/i.test(String(err));
}

export function createEngineChannel(options: EngineChannelOptions = {}): EngineChannel {
  const { directDispatch, pingIntervalMs = 50, pingTimeoutMs = 2000 } = options;

  let ready = false;
  let pending = false;
  let queue: Array<{ request: EngineRequest; resolve: (res: EngineResponse | undefined) => void }> =
    [];

  /** Gửi thẳng khi đã sẵn sàng; lỗi thì chỉ cảnh báo, không ném (send là phóng quên). */
  function directSend(request: EngineRequest): Promise<EngineResponse | undefined> {
    return api.runtime.sendMessage(request).then(
      (res) => res as EngineResponse | undefined,
      (err) => {
        warn('engine', 'engine không phản hồi', err);
        return undefined;
      },
    );
  }

  /** Xả toàn bộ hàng đợi theo FIFO, trả lời từng lệnh bằng đáp engine nhận được. */
  async function flushQueue(): Promise<void> {
    const items = queue;
    queue = [];
    for (const item of items) {
      try {
        const res = (await api.runtime.sendMessage(item.request)) as EngineResponse;
        item.resolve(res);
      } catch (err) {
        warn('engine', 'engine không phản hồi khi xả hàng', err);
        item.resolve(undefined);
      }
    }
  }

  /** Thăm dò engine:ping tới khi {ok:true} (xả hàng) hoặc hết giờ (bỏ hàng). */
  async function pingGate(): Promise<void> {
    await ensureDocumentContext();
    const deadline = Date.now() + pingTimeoutMs;
    for (;;) {
      try {
        const res = (await api.runtime.sendMessage({ type: 'engine:ping' })) as
          | { ok?: boolean }
          | undefined;
        if (res?.ok) {
          ready = true;
          pending = false;
          await flushQueue();
          return;
        }
      } catch {
        // Listener chưa đăng ký — thử lại sau một nhịp.
      }
      if (Date.now() >= deadline) {
        const dropped = queue;
        queue = [];
        for (const item of dropped) item.resolve(undefined);
        pending = false;
        warn(
          'engine',
          `engine không đáp lời ping sau ${pingTimeoutMs}ms, bỏ ${dropped.length} lệnh đang chờ`,
        );
        return;
      }
      await new Promise((r) => setTimeout(r, pingIntervalMs));
    }
  }

  /**
   * Lõi chung cho send/call. Không bao giờ reject: thất bại thì resolve undefined
   * (với warn) để UI bắt `void call(...)` không sinh rejection chưa bắt.
   */
  function dispatch(request: EngineRequest): Promise<EngineResponse | undefined> {
    // Firefox: engine cùng ngữ cảnh (background) hoặc đã lên sẵn (UI); không race.
    if (isFirefox) {
      if (directDispatch) {
        return directDispatch(request).catch((err) => {
          warn('engine', 'engine lỗi', err);
          return undefined;
        });
      }
      return directSend(request);
    }

    // Chromium: đã từng bắt được ack thì gửi thẳng.
    if (ready) return directSend(request);

    // Đang trong gate thì xếp hàng — đừng bắn thêm phát nào vào cửa sổ chết.
    if (pending) {
      return new Promise((resolve) => {
        queue.push({ request, resolve });
      });
    }

    // Trạng thái nhàn: thử gửi thẳng lệnh thật. Thành công nghĩa là engine đã lên,
    // khỏi ping. Thất bại dạng race mới xếp hàng (vào đầu, giữ FIFO) rồi ping.
    pending = true;
    return new Promise((resolve) => {
      (async () => {
        try {
          const res = (await api.runtime.sendMessage(request)) as EngineResponse;
          ready = true;
          pending = false;
          resolve(res);
          // Trong lúc chờ optimistic, có lệnh khác xếp hàng — xả nốt.
          await flushQueue();
        } catch (err) {
          if (!isRaceError(err)) {
            warn('engine', 'engine không phản hồi', err);
            pending = false;
            resolve(undefined);
            return;
          }
          // Lệnh đầu bị race, đặt về đầu hàng để xả trước (giữ đúng thứ tự phát).
          queue.unshift({ request, resolve });
          await pingGate();
        }
      })();
    });
  }

  return {
    send: (request) => dispatch(request).then(
      () => undefined,
      () => undefined,
    ),
    call: (request) => dispatch(request),
  };
}
