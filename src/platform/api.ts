/**
 * Lớp tương thích mỏng giữa Chromium và Firefox.
 *
 * Khác biệt đáng kể nhất: engine cần một ngữ cảnh có DOM (để tạo blob URL và
 * spawn Worker). Chromium MV3 chạy background trong service worker nên không có
 * DOM, phải mượn offscreen document. Firefox MV3 dùng event page vốn đã có DOM.
 */

declare const __TARGET__: 'chromium' | 'firefox';

export const TARGET: 'chromium' | 'firefox' =
  typeof __TARGET__ !== 'undefined' ? __TARGET__ : 'chromium';

export const isChromium = TARGET === 'chromium';
export const isFirefox = TARGET === 'firefox';

type Global = typeof globalThis & {
  browser?: typeof chrome;
  chrome?: typeof chrome;
};

/** Firefox phơi `browser` trả Promise; Chromium MV3 thì `chrome` cũng đã trả Promise. */
export const api: typeof chrome =
  (globalThis as Global).browser ?? (globalThis as Global).chrome!;

const OFFSCREEN_PATH = 'offscreen.html';

/** Bề mặt tối thiểu của chrome.offscreen; @types/chrome chưa phơi type này ra. */
interface OffscreenApi {
  hasDocument(): Promise<boolean>;
  createDocument(params: {
    url: string;
    reasons: string[];
    justification: string;
  }): Promise<void>;
  closeDocument(): Promise<void>;
}

/**
 * Bảo đảm có một ngữ cảnh DOM để chạy engine. Trả về true nếu ngữ cảnh nằm
 * ngoài background (Chromium), false nếu background tự lo được (Firefox).
 */
export async function ensureDocumentContext(): Promise<boolean> {
  if (!isChromium) return false;

  const offscreen = (api as unknown as { offscreen?: OffscreenApi }).offscreen;
  if (!offscreen) return false;

  if (await offscreen.hasDocument()) return true;

  try {
    await offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ['WORKERS', 'BLOBS'],
      justification:
        'Chay web worker tai song song va tao blob URL de ban giao file cho trinh duyet.',
    });
  } catch (err) {
    // Hai lời gọi song song có thể cùng tạo; lần thua cuộc chỉ cần bỏ qua.
    if (!(await offscreen.hasDocument())) throw err;
  }
  return true;
}

export function runtimeUrl(path: string): string {
  return api.runtime.getURL(path);
}
