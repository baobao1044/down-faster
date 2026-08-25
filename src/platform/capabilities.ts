/** Dò khả năng của môi trường trước khi engine cam kết một chiến lược. */

export interface Capabilities {
  /** Có OPFS để ghi thẳng xuống đĩa thay vì gom trong RAM. */
  opfs: boolean;
  /** Có createSyncAccessHandle trong worker, đường ghi random-access nhanh nhất. */
  syncAccessHandle: boolean;
  /** Có thể xin quota không giới hạn (quyền unlimitedStorage). */
  persistentStorage: boolean;
}

export async function detectCapabilities(): Promise<Capabilities> {
  const opfs = typeof navigator !== 'undefined' && !!navigator.storage?.getDirectory;

  let syncAccessHandle = false;
  if (opfs) {
    try {
      const dir = await navigator.storage.getDirectory();
      const probe = await dir.getFileHandle('.df-probe', { create: true });
      syncAccessHandle = typeof (probe as FileSystemFileHandle & {
        createSyncAccessHandle?: unknown;
      }).createSyncAccessHandle === 'function';
      await dir.removeEntry('.df-probe').catch(() => {});
    } catch {
      syncAccessHandle = false;
    }
  }

  let persistentStorage = false;
  try {
    persistentStorage = (await navigator.storage?.persisted?.()) ?? false;
    if (!persistentStorage) {
      persistentStorage = (await navigator.storage?.persist?.()) ?? false;
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
 * vài trình duyệt, và `createSyncAccessHandle` chỉ có trong worker.
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
