/// <reference lib="webworker" />
import type { WriteAck, WriteRequest, WriterCommand, WriterEvent } from '../../shared/protocol';

/**
 * Người ghi duy nhất của một file tải.
 *
 * `createSyncAccessHandle()` giữ khóa độc quyền, nên không thể để mỗi fetch worker
 * tự mở handle trên cùng file. Thay vào đó tất cả buffer dồn về đây qua MessagePort
 * và được ghi bằng lời gọi đồng bộ theo offset. Ghi đĩa gần như luôn nhanh hơn tải
 * mạng nên một người ghi là đủ, và cách này chạy giống nhau trên cả hai trình duyệt.
 */

const scope = self as unknown as DedicatedWorkerGlobalScope;

let handle: FileSystemSyncAccessHandle | null = null;
let written = 0;

function emit(event: WriterEvent): void {
  scope.postMessage(event);
}

async function open(fileName: string, size: number): Promise<void> {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle('parts', { create: true });
  const file = await dir.getFileHandle(fileName, { create: true });
  handle = await file.createSyncAccessHandle();

  // Cấp phát trước đúng dung lượng để các piece ghi vào giữa file mà không phải nới dần.
  if (size > 0) handle.truncate(size);
  emit({ type: 'ready' });
}

/** Mỗi fetch worker nói chuyện với writer qua một port riêng. */
function attach(port: MessagePort): void {
  port.onmessage = (event: MessageEvent<WriteRequest>) => {
    const { offset, buffer } = event.data;
    // Biên nhận là van điều áp của fetch worker. Nó phải trả về đúng số byte đã
    // nhận trong mọi nhánh, kể cả nhánh lỗi, nếu không bên kia sẽ chờ mãi.
    const size = buffer.byteLength;
    try {
      if (!handle) throw new Error('File tạm chưa được mở');
      handle.write(new Uint8Array(buffer), { at: offset });
      written += size;
    } catch (err) {
      emit({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      port.postMessage({ written: size } satisfies WriteAck);
    }
  };
  port.start();
}

scope.onmessage = (event: MessageEvent<WriterCommand>) => {
  const msg = event.data;
  void (async () => {
    try {
      switch (msg.type) {
        case 'open':
          await open(msg.fileName, msg.size);
          break;
        case 'attach': {
          const port = event.ports[0];
          if (port) attach(port);
          break;
        }
        case 'flush':
          handle?.flush();
          emit({ type: 'flushed' });
          break;
        case 'close': {
          handle?.flush();
          handle?.close();
          handle = null;
          emit({ type: 'closed', size: written });
          break;
        }
      }
    } catch (err) {
      emit({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  })();
};
