/**
 * Content script phát hiện video trong trang.
 *
 * Ba ràng buộc định hình toàn bộ file này:
 *
 *   1. KHÔNG export gì ở tầng cao nhất. Content script được nạp như classic script,
 *      mà esbuild lại xuất ESM; module có export sẽ sinh ra dòng `export {}` và trang
 *      lập tức SyntaxError. Toàn bộ mã nằm trong một IIFE nên cũng không rò biến nào
 *      ra phạm vi toàn cục — của trang lẫn của chương trình TypeScript.
 *   2. KHÔNG import `platform/api`. Gói này bị tiêm vào MỌI trang, nên nó phải nhỏ và
 *      không kéo theo mấy helper offscreen vốn vô dụng ở đây. Ba dòng tự khai `runtime`
 *      rẻ hơn nhiều so với một cây import.
 *   3. Chi phí gần bằng 0 khi trang đứng yên. Không MutationObserver: MSE khiến
 *      `<video>.src` chỉ là `blob:` nên quét DOM liên tục vừa vô ích vừa đúng là thứ
 *      làm chậm các SPA nặng. URL .m3u8/.mpd thật chỉ lộ ra ở tầng mạng, và
 *      PerformanceObserver thấy được chúng gần như miễn phí.
 */

(() => {
  /* ---------- Hợp đồng thông điệp (sẽ nhân bản sang shared/rpc.ts khi tích hợp) ---------- */

  interface MediaCandidate {
    url: string;
    kind: 'hls' | 'dash' | 'file';
    via: 'video-src' | 'source-el' | 'resource-timing';
    /** Gợi ý tên file, lấy từ tiêu đề trang. */
    label: string | null;
    /** Giây, nếu thẻ <video> đã biết. */
    duration: number | null;
    width: number | null;
    height: number | null;
  }

  interface RuntimeLike {
    id?: string;
    sendMessage(message: unknown): Promise<unknown>;
    onMessage: {
      addListener(
        callback: (
          message: unknown,
          sender: unknown,
          sendResponse: (response: unknown) => void,
        ) => boolean | void,
      ): void;
    };
  }

  interface StorageLike {
    local: { get(key: string): Promise<Record<string, unknown>> };
  }

  type ExtensionGlobal = typeof globalThis & {
    browser?: { runtime?: RuntimeLike; storage?: StorageLike };
    chrome?: { runtime?: RuntimeLike; storage?: StorageLike };
  };

  const g = globalThis as ExtensionGlobal;
  const runtime = g.browser?.runtime ?? g.chrome?.runtime;
  const storage = g.browser?.storage ?? g.chrome?.storage;

  // Không có runtime nghĩa là script bị nạp nhầm chỗ; im lặng rút lui.
  if (!runtime?.id) return;
  // Trang nội bộ của trình duyệt và about:blank không có gì để tìm.
  if (!/^https?:$/.test(location.protocol)) return;

  /* ---------- Hằng số ---------- */

  /** Gom nhiều phát hiện thành một lượt gửi; trang video bắn ra hàng loạt cùng lúc. */
  const FLUSH_DELAY_MS = 800;
  /** Trần cứng cho mỗi khung. Một playlist đang phát sinh ra hàng nghìn entry. */
  const MAX_ITEMS = 64;

  const HLS_PATTERN = /\.m3u8?(?![a-z0-9])/i;
  const DASH_PATTERN = /\.mpd(?![a-z0-9])/i;
  /**
   * Cố tình KHÔNG có .ts và .m4s: đứng ở resource timing thì chúng gần như chắc chắn
   * là segment của một playlist chứ không phải file rời. Nhận chúng là tự dìm mình
   * trong hàng nghìn mục vô nghĩa và làm mất luôn cái playlist thật giữa đống đó.
   */
  const FILE_PATTERN = /\.(mp4|m4v|webm|mov|mkv|avi|flv|wmv|m4a|mp3|aac|flac|ogg|opus|wav)(?![a-z0-9])/i;

  /* ---------- Trạng thái ---------- */

  const seen = new Map<string, MediaCandidate>();
  /** Chỉ những mục chưa gửi; background tự tích lũy phần còn lại. */
  let unsent: MediaCandidate[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let disabled = false;
  let observer: PerformanceObserver | null = null;

  /* ---------- Nhận dạng ---------- */

  function classify(url: string): MediaCandidate['kind'] | null {
    if (!/^https?:\/\//i.test(url)) return null;

    let hay = url;
    try {
      const parsed = new URL(url);
      hay = `${parsed.pathname}${parsed.search}`;
    } catch {
      // URL rác: soi nguyên chuỗi, tệ nhất là đoán sai một mục.
    }

    let decoded = hay;
    try {
      decoded = decodeURIComponent(hay);
    } catch {
      // Chuỗi phần trăm hỏng thì dùng bản gốc.
    }

    if (HLS_PATTERN.test(decoded) || /mpegurl/i.test(decoded)) return 'hls';
    if (DASH_PATTERN.test(decoded) || /dash\+xml/i.test(decoded)) return 'dash';
    if (FILE_PATTERN.test(decoded)) return 'file';
    return null;
  }

  function pageLabel(): string | null {
    const title = document.title.trim();
    return title || null;
  }

  function remember(url: string, via: MediaCandidate['via'], el?: HTMLMediaElement): void {
    if (disabled || seen.size >= MAX_ITEMS || seen.has(url)) return;

    const kind = classify(url);
    if (!kind) return;

    const video = el instanceof HTMLVideoElement ? el : null;
    const candidate: MediaCandidate = {
      url,
      kind,
      via,
      label: pageLabel(),
      duration: el && Number.isFinite(el.duration) && el.duration > 0 ? el.duration : null,
      width: video?.videoWidth || null,
      height: video?.videoHeight || null,
    };

    seen.set(url, candidate);
    unsent.push(candidate);
    schedule();
  }

  /* ---------- Gửi về background ---------- */

  function schedule(): void {
    if (flushTimer !== null || disabled) return;
    flushTimer = setTimeout(flush, FLUSH_DELAY_MS);
  }

  function flush(): void {
    flushTimer = null;
    if (disabled || unsent.length === 0) return;

    const items = unsent;
    unsent = [];
    try {
      // Background có thể đang ngủ hoặc chưa gắn listener; đó là chuyện bình thường
      // và không được phép làm nổ một trang của người dùng.
      void runtime!
        .sendMessage({
          type: 'media:found',
          pageUrl: location.href,
          pageTitle: document.title,
          items,
        })
        .catch(() => {});
    } catch {
      // Extension vừa được nạp lại: ngữ cảnh cũ chết hẳn và sendMessage ném ĐỒNG BỘ,
      // không phải trả về promise bị từ chối. Không còn ai để gửi nên nhả sạch tài
      // nguyên thay vì để lại một observer chạy vô ích trên trang của người dùng.
      teardown();
    }
  }

  /* ---------- Quét thẻ media ---------- */

  function scanElement(el: HTMLMediaElement): void {
    // currentSrc là thứ trình duyệt đang thật sự phát; src có thể chỉ là ý định.
    if (el.currentSrc) remember(el.currentSrc, 'video-src', el);
    if (el.src) remember(el.src, 'video-src', el);

    for (const source of Array.from(el.querySelectorAll('source'))) {
      if (source.src) remember(source.src, 'source-el', el);
    }
  }

  function scanMediaElements(): void {
    if (disabled) return;
    for (const el of Array.from(document.querySelectorAll('video, audio'))) {
      if (el instanceof HTMLMediaElement) scanElement(el);
    }
  }

  /* ---------- Bộ máy ---------- */

  function startObserver(): void {
    if (typeof PerformanceObserver === 'undefined') return;

    try {
      observer = new PerformanceObserver((list) => {
        if (disabled) return;
        for (const entry of list.getEntries()) remember(entry.name, 'resource-timing');
      });
      // buffered: true lấy được cả entry ghi TRƯỚC khi script chạy, và quan trọng hơn
      // là vẫn nhận entry mới sau khi bộ đệm resource timing (mặc định 250 mục) đã đầy —
      // điều mà một lần getEntriesByType() không làm được, trong khi trang video làm
      // đầy bộ đệm đó chỉ trong vài giây.
      observer.observe({ type: 'resource', buffered: true });
    } catch {
      // Trình duyệt không hỗ trợ loại 'resource': bỏ qua, vẫn còn đường quét thẻ.
    }
  }

  function onMediaEvent(event: Event): void {
    const target = event.target;
    if (target instanceof HTMLMediaElement) scanElement(target);
  }

  function teardown(): void {
    disabled = true;
    observer?.disconnect();
    observer = null;
    if (flushTimer !== null) clearTimeout(flushTimer);
    flushTimer = null;
    seen.clear();
    unsent = [];
    document.removeEventListener('loadstart', onMediaEvent, true);
    document.removeEventListener('loadedmetadata', onMediaEvent, true);
    document.removeEventListener('play', onMediaEvent, true);
  }

  /** Người dùng tắt hẳn tính năng thì phải nhả mọi thứ, không chỉ ngừng gửi. */
  function honourSetting(): void {
    if (!storage) return;
    void storage.local
      .get('settings')
      .then((stored) => {
        const settings = stored?.['settings'] as { detectMedia?: boolean } | undefined;
        if (settings?.detectMedia === false) teardown();
      })
      .catch(() => {});
  }

  startObserver();

  // Pha capture đi qua document kể cả với sự kiện không nổi bọt, nên bắt được cả
  // thẻ <video> mà player chèn vào sau. Rẻ hơn hẳn MutationObserver trên subtree.
  document.addEventListener('loadstart', onMediaEvent, true);
  document.addEventListener('loadedmetadata', onMediaEvent, true);
  document.addEventListener('play', onMediaEvent, true);

  const idle = (globalThis as typeof globalThis & {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void;
  }).requestIdleCallback;
  if (idle) idle(scanMediaElements, { timeout: 2000 });
  else setTimeout(scanMediaElements, 500);

  runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const msg = message as { type?: string } | null;
    if (msg?.type !== 'media:query') return false;

    // Quét lại ngay lúc được hỏi: popup thường mở sau khi video đã bắt đầu phát.
    scanMediaElements();
    sendResponse({ type: 'media:list', items: [...seen.values()] });
    return false;
  });

  honourSetting();
})();
