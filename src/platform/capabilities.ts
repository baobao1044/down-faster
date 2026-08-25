/** Dò khả năng của môi trường trước khi engine cam kết một chiến lược. */

export interface Capabilities {
  /** Có OPFS để ghi thẳng xuống đĩa thay vì gom trong RAM. */
  opfs: boolean;
  /** Có createSyncAccessHandle trong worker, đường ghi random-access nhanh nhất. */
  syncAccessHandle: boolean;
  /** Có thể xin quota không giới hạn (quyền unlimitedStorage). */
  persistentStorage: boolean;
}

/** Bề mặt của môi trường mà phép dò cần; tách ra để test dựng được từng ngữ cảnh. */
export interface CapabilityEnv {
  /**
   * `createSyncAccessHandle` chỉ tồn tại trong worker, nên kết quả phép dò phụ
   * thuộc vào việc đang đứng ở đâu — không chỉ vào trình duyệt nào.
   */
  inWorker: boolean;
  /** `navigator.storage`, hoặc undefined khi môi trường không có OPFS. */
  storage?: {
    getDirectory(): Promise<unknown>;
    persisted?(): Promise<boolean>;
    persist?(): Promise<boolean>;
  };
}

function currentEnv(): CapabilityEnv {
  return {
    // WorkerGlobalScope chỉ có trong worker; document và service worker đều khác nhau
    // ở chỗ này, nên đừng đoán theo sự vắng mặt của `window`.
    inWorker:
      typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !== 'undefined',
    storage:
      typeof navigator !== 'undefined'
        ? (navigator.storage as CapabilityEnv['storage'])
        : undefined,
  };
}

export async function detectCapabilities(env: CapabilityEnv = currentEnv()): Promise<Capabilities> {
  const opfs = !!env.storage?.getDirectory;

  let syncAccessHandle = false;
  if (opfs && env.storage) {
    if (env.inWorker) {
      // Trong worker thì dò được thật, và câu trả lời ở đây mới có giá trị.
      try {
        const dir = (await env.storage.getDirectory()) as {
          getFileHandle(name: string, opts: { create: boolean }): Promise<unknown>;
          removeEntry(name: string): Promise<void>;
        };
        const probe = (await dir.getFileHandle('.df-probe', { create: true })) as {
          createSyncAccessHandle?: unknown;
        };
        syncAccessHandle = typeof probe.createSyncAccessHandle === 'function';
        await dir.removeEntry('.df-probe').catch(() => {});
      } catch {
        syncAccessHandle = false;
      }
    } else {
      // Ngoài worker thì KHÔNG dò được: theo đặc tả `createSyncAccessHandle` vắng
      // mặt trên mọi file handle ở luồng chính, kể cả khi trình duyệt hỗ trợ đầy
      // đủ. Dò ở đây rồi kết luận "không hỗ trợ" là đọc sai một sự vắng mặt cố ý
      // — và đó chính là lỗi từng làm mọi lượt tải trên Chromium bị trả lại cho
      // trình duyệt, vì engine chạy trong offscreen document chứ không trong worker.
      //
      // Việc ghi thật nằm ở `writer-worker`. Nếu ở đó API vẫn thiếu thì lệnh
      // `open` phát ra event `error`, orchestrator gọi `fail()` và lượt tải vẫn
      // được trả lại tử tế. Có OPFS là đủ để đi tiếp.
      syncAccessHandle = true;
    }
  }

  let persistentStorage = false;
  try {
    persistentStorage = (await env.storage?.persisted?.()) ?? false;
    if (!persistentStorage) {
      persistentStorage = (await env.storage?.persist?.()) ?? false;
    }
  } catch {
    persistentStorage = false;
  }

  return { opfs, syncAccessHandle, persistentStorage };
}

/**
 * Một lần dò cho cả phiên. Dò lại mỗi lượt tải là thừa, mà lại tạo và xoá file
 * thăm dò trên OPFS mỗi lần — đúng thứ hệ thống file không thích.
 */
let cached: Promise<Capabilities> | null = null;

export function capabilities(detect = detectCapabilities): Promise<Capabilities> {
  cached ??= detect();
  return cached;
}

/** Chỉ dùng trong test: quên kết quả đã nhớ. */
export function resetCapabilities(): void {
  cached = null;
}

/**
 * Chặn sớm khi môi trường không ghi nổi file tạm.
 *
 * Không có bước này thì engine đi hết đường thăm dò, chia piece, spawn worker rồi
 * mới chết ở lời gọi `createSyncAccessHandle()` đầu tiên — thông báo lỗi khi đó
 * nói về một API mà người dùng chưa nghe bao giờ. Tệ hơn, ở chế độ tự động thì
 * lượt tải đã bị giành mất khỏi trình duyệt rồi. Hỏng sớm và hỏng rõ ràng thì
 * `fail()` còn kịp trả URL gốc về cho trình duyệt tải kiểu thường.
 *
 * Đây KHÔNG phải trường hợp hiếm: OPFS vắng mặt trong chế độ duyệt riêng tư của
 * vài trình duyệt.
 *
 * Chốt này chỉ chặn những gì nhìn thấy được từ ngữ cảnh đang gọi. Riêng
 * `createSyncAccessHandle` thì không: nó chỉ tồn tại trong worker, nên khi gọi từ
 * offscreen document `detectCapabilities` cố tình không kết luận là thiếu. Người
 * gác cổng thật cho đường ghi là lệnh `open` của writer-worker.
 */
export async function requireStorage(detect = detectCapabilities): Promise<void> {
  const caps = await capabilities(detect);
  if (!caps.opfs) {
    throw new Error('Trình duyệt không cho dùng bộ nhớ tạm (OPFS) nên không tải nhiều luồng được');
  }
  if (!caps.syncAccessHandle) {
    throw new Error('Trình duyệt không hỗ trợ ghi file tạm theo offset (createSyncAccessHandle)');
  }
}
