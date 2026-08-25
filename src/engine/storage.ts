/**
 * Lưu trữ tạm trên OPFS.
 *
 * Đây là mấu chốt để tải được file lớn: gom chunk trong RAM rồi mới ghép sẽ làm
 * sập tab ở vài GB, còn OPFS cho phép ghi thẳng xuống đĩa theo offset bất kỳ.
 * Khi tải xong, `getFile()` trả về một File tựa trên đĩa nên tạo blob URL từ nó
 * không kéo toàn bộ nội dung vào bộ nhớ.
 */

const PARTS_DIR = 'parts';

export async function partsDirectory(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(PARTS_DIR, { create: true });
}

export function partName(id: string): string {
  return `${id}.part`;
}

export async function createPart(id: string): Promise<FileSystemFileHandle> {
  const dir = await partsDirectory();
  return dir.getFileHandle(partName(id), { create: true });
}

export async function removePart(id: string): Promise<void> {
  try {
    const dir = await partsDirectory();
    await dir.removeEntry(partName(id));
  } catch {
    // File có thể đã bị dọn từ trước; không có gì để làm thêm.
  }
}

export async function partSize(id: string): Promise<number> {
  try {
    const dir = await partsDirectory();
    const handle = await dir.getFileHandle(partName(id));
    return (await handle.getFile()).size;
  } catch {
    return 0;
  }
}

/** Tạo blob URL trỏ tới file tạm để bàn giao cho API downloads của trình duyệt. */
export async function partAsBlobUrl(id: string, mimeType?: string | null): Promise<string> {
  const dir = await partsDirectory();
  const handle = await dir.getFileHandle(partName(id));
  const file = await handle.getFile();
  const blob = mimeType ? file.slice(0, file.size, mimeType) : file;
  return URL.createObjectURL(blob);
}

export interface QuotaInfo {
  usage: number;
  quota: number;
  available: number;
}

export async function quota(): Promise<QuotaInfo> {
  const est = await navigator.storage.estimate();
  const usage = est.usage ?? 0;
  const q = est.quota ?? 0;
  return { usage, quota: q, available: Math.max(0, q - usage) };
}

/** Xóa mọi file tạm còn sót lại, dùng khi extension khởi động. */
export async function cleanupOrphans(keep: Set<string>): Promise<number> {
  let removed = 0;
  try {
    const dir = await partsDirectory();
    const entries = (dir as unknown as {
      keys(): AsyncIterableIterator<string>;
    }).keys();
    const stale: string[] = [];
    for await (const name of entries) {
      const id = name.replace(/\.part$/, '');
      if (!keep.has(id)) stale.push(name);
    }
    for (const name of stale) {
      await dir.removeEntry(name).catch(() => {});
      removed += 1;
    }
  } catch {
    // OPFS không dùng được thì cũng chẳng có gì để dọn.
  }
  return removed;
}
