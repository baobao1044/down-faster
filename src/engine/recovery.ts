/**
 * Khôi phục lượt tải dở sau khi trình duyệt đóng.
 *
 * Nhiệm vụ thật sự của module này không phải là "tải tiếp" — mà là biết khi nào
 * KHÔNG được tải tiếp. Nối byte mới vào một file mà server đã thay đổi cho ra một
 * file hỏng mở lên mới biết, và đó là loại lỗi tệ nhất vì người dùng không có cách
 * nào nhận ra. Mọi nghi ngờ đều nghiêng về phía tải lại từ đầu.
 *
 * Một phát hiện quan trọng khi đọc writer-worker: nó gọi `handle.truncate(size)`
 * ngay lúc mở file, nên kích thước file `.part` LUÔN bằng đúng kích thước tổng kể
 * từ byte đầu tiên. Nó là phép kiểm tra nhất quán, không phải chỉ báo tiến độ.
 * Nguồn sự thật về tiến độ buộc phải là bản đồ piece đã lưu.
 */

import { totalReceived } from './pieces';
import * as storage from './storage';
import { warn } from '../shared/log';
import type { PersistedTask, ResumeSeed, TaskPersistence } from './persistence';
import { decodePieces } from './persistence';
import type { Piece, ProbeResult } from './types';

/**
 * Biên an toàn: mọi piece dở dang lùi lại chừng này byte khi khôi phục.
 *
 * CẢNH BÁO CHO NGƯỜI SỬA writer-worker: con số này chỉ đúng chừng nào fetch worker
 * còn bị điều áp theo `writeHighWaterMark` và còn gộp tiến độ mỗi 250ms. Nó bù cho
 * một khoảng đua có thật: fetch worker post buffer qua MessagePort riêng còn
 * orchestrator post lệnh flush qua kênh chính, hai kênh không có bảo đảm thứ tự
 * với nhau. Nếu bỏ điều áp, nâng high-water mark, hay cho nhiều writer cùng ghi,
 * phải tính lại chỗ này — sai theo hướng thiếu thì tải lại vài MiB, sai theo hướng
 * thừa thì giao file hỏng.
 */
export const RESUME_REWIND_BYTES = 1024 * 1024;

export type ValidatorVerdict = 'same' | 'changed' | 'unverifiable';

/**
 * ETag yếu (`W/"..."`) không dùng được cho If-Range.
 *
 * RFC 9110 bắt buộc so sánh mạnh cho If-Range: gặp validator yếu, server PHẢI trả
 * 200 kèm nguyên file thay vì 206. Với một piece ở giữa file, fetch-worker khi đó
 * ném PieceError không thể thử lại và cả lượt tải chết cứng. Về mặt ngữ nghĩa,
 * ETag yếu nghĩa là "tương đương về nội dung" chứ không phải "giống từng byte" —
 * đúng thứ ta không được phép giả định khi ghép byte cũ với byte mới.
 */
export function isWeakValidator(etag: string | null): boolean {
  if (!etag) return false;
  return /^\s*[Ww]\//.test(etag);
}

/** So sánh mạnh theo RFC 9110: đúng từng ký tự, kể cả dấu nháy. */
function sameStrongEtag(a: string, b: string): boolean {
  return a.trim() === b.trim();
}

/** Hai chuỗi Last-Modified khác định dạng vẫn có thể chỉ cùng một mốc thời gian. */
function sameHttpDate(a: string, b: string): boolean {
  if (a.trim() === b.trim()) return true;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  return Number.isFinite(ta) && Number.isFinite(tb) && ta === tb;
}

/**
 * Bằng chứng ưu tiên theo độ chắc chắn: kích thước, rồi ETag mạnh, rồi
 * Last-Modified. `unverifiable` không phải là "chắc còn nguyên" — nó là "không
 * chứng minh được", và với việc nối byte thì hai thứ đó phải bị đối xử như nhau.
 */
export function compareValidators(
  stored: { etag: string | null; lastModified: string | null; size: number },
  fresh: { etag: string | null; lastModified: string | null; size: number | null },
): ValidatorVerdict {
  if (fresh.size === null) return 'unverifiable';
  if (fresh.size !== stored.size) return 'changed';

  if (stored.etag !== null && fresh.etag !== null) {
    if (isWeakValidator(stored.etag) || isWeakValidator(fresh.etag)) return 'unverifiable';
    return sameStrongEtag(stored.etag, fresh.etag) ? 'same' : 'changed';
  }
  // Trước có ETag giờ không: server đổi cấu hình hoặc ta đang nói chuyện với node
  // khác. Không còn gì để đối chiếu ở mức chắc chắn nhất.
  if (stored.etag !== null && fresh.etag === null) return 'unverifiable';

  if (stored.lastModified !== null && fresh.lastModified !== null) {
    return sameHttpDate(stored.lastModified, fresh.lastModified) ? 'same' : 'changed';
  }
  return 'unverifiable';
}

/** Những gì OPFS nói về file tạm. */
export interface PartFacts {
  exists: boolean;
  /** Bằng đúng record.size khi lành lặn, vì writer đã truncate sẵn. */
  size: number;
}

export type Verdict =
  | { action: 'resume'; record: PersistedTask; pieces: Piece[]; remaining: number }
  | { action: 'restart'; record: PersistedTask; reason: string }
  | { action: 'discard'; id: string; reason: string };

/**
 * Dựng lại piece từ bản đồ đã lưu, lùi biên an toàn cho mọi piece dở dang.
 *
 * Piece đã `done` được tin không lùi, vì fetch-worker chỉ phát `done` sau khi mọi
 * chunk của piece đó đã được post sang writer và orchestrator chốt lại
 * `received = end - start + 1`.
 */
export function rebuildPieces(
  record: PersistedTask,
  rewindBytes: number = RESUME_REWIND_BYTES,
): Piece[] | null {
  const pieces = decodePieces(record.pieces, record.size);
  if (!pieces) return null;

  for (const piece of pieces) {
    if (piece.state === 'done') continue;
    piece.received = Math.max(0, piece.received - Math.max(0, rewindBytes));
    piece.state = 'pending';
    piece.attempts = 0;
  }
  return pieces;
}

/**
 * Đối chiếu ngoại tuyến, không chạm mạng. Chạy lúc khởi động.
 *
 * Cố ý không thăm dò server ở đây: lúc trình duyệt khởi động thường chưa có mạng,
 * và bắn N request cùng lúc sẽ đánh dấu hỏng oan N lượt tải. Việc xác minh
 * validator để dành cho `verifyAgainstProbe()` lúc người dùng bấm Tiếp tục.
 */
export function reconcile(record: PersistedTask, part: PartFacts): Verdict {
  if (!part.exists) {
    return {
      action: 'discard',
      id: record.id,
      reason: 'Không còn file tạm trong OPFS, bản ghi đã mồ côi',
    };
  }

  // Phép kiểm tra này gắn chặt với việc writer cấp phát trước bằng truncate(size).
  // Lệch nghĩa là file tạm bị cắt cụt, bị ghi bởi phiên bản engine khác, hoặc phiên
  // trước chết trước khi kịp truncate — không trường hợp nào nối tiếp được.
  if (part.size !== record.size) {
    return {
      action: 'restart',
      record,
      reason: `File tạm dài ${part.size} byte, bản ghi nói ${record.size} byte`,
    };
  }

  const pieces = rebuildPieces(record);
  if (!pieces) {
    return { action: 'restart', record, reason: 'Bản đồ piece không dựng lại được' };
  }

  const remaining = Math.max(0, record.size - totalReceived(pieces));

  // Server không nhận Range thì không xin được khúc giữa. Nhưng khi mọi piece đã
  // xong thì chẳng còn byte nào phải xin, chỉ còn bước ghép file — chặn ở đây sẽ
  // bắt tải lại một file đã nằm đủ trên đĩa.
  if (remaining > 0 && !record.acceptRanges) {
    return {
      action: 'restart',
      record,
      reason: 'Server không hỗ trợ tải theo khoảng byte nên không nối tiếp được',
    };
  }

  return { action: 'resume', record, pieces, remaining };
}

/**
 * Xác minh trực tuyến, chạy lúc người dùng bấm Tiếp tục, sau khi đã thăm dò lại
 * bằng `record.url` (URL GỐC, không phải finalUrl cũ).
 *
 * finalUrl đổi KHÔNG bị coi là file đã đổi: CDN xoay node liên tục mà nội dung y
 * nguyên, bắt lỗi theo finalUrl sẽ ép tải lại từ đầu vô cớ.
 */
export function verifyAgainstProbe(
  record: PersistedTask,
  probe: ProbeResult,
): { ok: true } | { ok: false; reason: string } {
  if (!probe.acceptRanges) {
    return { ok: false, reason: 'Server không còn cho tải theo khoảng byte' };
  }
  if (probe.size === null) {
    return { ok: false, reason: 'Server không cho biết kích thước file' };
  }

  const verdict = compareValidators(
    { etag: record.etag, lastModified: record.lastModified, size: record.size },
    { etag: probe.etag, lastModified: probe.lastModified, size: probe.size },
  );

  if (verdict === 'same') return { ok: true };
  if (verdict === 'changed') {
    return { ok: false, reason: 'File trên server đã thay đổi kể từ lần tải trước' };
  }
  return {
    ok: false,
    reason: 'Không xác minh được file còn nguyên vẹn (server dùng ETag yếu hoặc không gửi ETag)',
  };
}

/* ---------- Đọc file tạm ---------- */

export interface PartInspector {
  list(): Promise<Set<string>>;
  size(id: string): Promise<number>;
  remove(id: string): Promise<void>;
}

const PART_SUFFIX = '.part';

/**
 * Bản cài đặt thật trên OPFS.
 *
 * CHỈ được dùng lúc khởi động, khi chưa writer nào mở SyncAccessHandle:
 * `getFile()` mà handle độc quyền đang mở sẽ thất bại. Đừng chuyển các phép đọc
 * này vào giữa vòng tải.
 *
 * `list()` cố ý ĐỂ LỖI LỌT RA thay vì trả về tập rỗng. Tập rỗng nói dối rằng không
 * còn file tạm nào, và `planRecovery()` sẽ tin lời nói dối đó mà vứt sạch bản ghi;
 * người gọi cần phân biệt được "không có gì" với "không đọc được".
 */
export const opfsParts: PartInspector = {
  async list(): Promise<Set<string>> {
    const ids = new Set<string>();
    const dir = await storage.partsDirectory();
    // Cùng phép ép kiểu mà cleanupOrphans đang dùng: keys() chưa có trong lib dom.
    const keys = (dir as unknown as {
      keys(): AsyncIterableIterator<string>;
    }).keys();
    for await (const name of keys) {
      if (name.endsWith(PART_SUFFIX)) ids.add(name.slice(0, -PART_SUFFIX.length));
    }
    return ids;
  },
  size(id: string): Promise<number> {
    return storage.partSize(id);
  },
  remove(id: string): Promise<void> {
    return storage.removePart(id);
  },
};

/* ---------- Kế hoạch khởi động ---------- */

export interface RecoveryPlan {
  resumable: Array<{ record: PersistedTask; seed: ResumeSeed }>;
  /** Giữ metadata nhưng bỏ hết tiến độ: file tạm không dùng lại được. */
  restartable: Array<{ record: PersistedTask; reason: string }>;
  discarded: Array<{ id: string; reason: string }>;
  /** id của .part được giữ lại. Truyền THẲNG cho storage.cleanupOrphans(). */
  keep: Set<string>;
  /**
   * Không liệt kê được thư mục parts. Kế hoạch khi đó cố tình rỗng: không phán
   * quyết gì, không xóa gì, chỉ giữ nguyên hiện trạng cho lần khởi động sau.
   */
  partsUnreadable: boolean;
}

export function toResumeSeed(record: PersistedTask, pieces: Piece[]): ResumeSeed {
  return {
    id: record.id,
    source: record.source,
    createdAt: record.createdAt,
    url: record.url,
    finalUrl: record.finalUrl,
    filename: record.filename,
    mimeType: record.mimeType,
    size: record.size,
    acceptRanges: record.acceptRanges,
    etag: record.etag,
    lastModified: record.lastModified,
    pieces,
    received: totalReceived(pieces),
  };
}

/** Chỉ cần chừng này của TaskPersistence, nhờ vậy test tiêm được bản giả. */
export type RecoverySource = Pick<TaskPersistence, 'loadAll' | 'forget'>;

/**
 * Dựng kế hoạch khôi phục lúc khởi động.
 *
 * PHẢI chạy TRƯỚC `storage.cleanupOrphans()`, và kết quả `plan.keep` phải được
 * truyền vào chính lời gọi đó. `cleanupOrphans(new Set())` xóa sạch mọi file tạm,
 * biến toàn bộ module persistence thành vô nghĩa mà không phát ra lỗi nào.
 */
/** Lỗi xóa một bản ghi không được phép làm chết cả bước khởi động. */
async function forgetQuietly(persistence: RecoverySource, id: string): Promise<void> {
  try {
    await persistence.forget(id);
  } catch (err) {
    warn('recovery', `không xóa được bản ghi ${id}`, err);
  }
}

export async function planRecovery(
  persistence: RecoverySource,
  inspector: PartInspector = opfsParts,
): Promise<RecoveryPlan> {
  const plan: RecoveryPlan = {
    resumable: [],
    restartable: [],
    discarded: [],
    keep: new Set<string>(),
    partsUnreadable: false,
  };

  const { records, removedIds } = await persistence.loadAll();
  for (const id of removedIds) {
    plan.discarded.push({ id, reason: 'Bản ghi hỏng, quá hạn hoặc vượt hạn mức lưu' });
  }

  let present: Set<string>;
  try {
    present = await inspector.list();
  } catch (err) {
    // "Không đọc được thư mục parts" KHÔNG phải là "không còn file tạm". Nhầm hai
    // thứ này là mất trắng: mọi bản ghi bị coi là mồ côi và xóa đi, rồi
    // cleanupOrphans(keep rỗng) dọn nốt phần dữ liệu còn lại. Một lần OPFS trở
    // chứng không đáng để đánh đổi như vậy — phiên này không khôi phục gì cả,
    // nhưng cũng không phá gì, và lần khởi động sau thử lại.
    warn('recovery', 'không liệt kê được thư mục parts, hoãn khôi phục phiên này', err);
    plan.partsUnreadable = true;
    for (const record of records) plan.keep.add(record.id);
    return plan;
  }

  for (const record of records) {
    const exists = present.has(record.id);
    // Đọc kích thước hỏng thì coi như file tạm không dùng được. Để lỗi lan ra sẽ
    // làm hỏng cả bước khởi động, và khi đó cleanupOrphans không bao giờ chạy.
    let size = 0;
    if (exists) {
      try {
        size = await inspector.size(record.id);
      } catch {
        size = 0;
      }
    }
    const verdict = reconcile(record, { exists, size });

    switch (verdict.action) {
      case 'resume':
        plan.resumable.push({ record, seed: toResumeSeed(record, verdict.pieces) });
        plan.keep.add(record.id);
        break;
      case 'restart':
        plan.restartable.push({ record, reason: verdict.reason });
        // Bản ghi không còn mô tả đúng thứ gì trên đĩa nữa; giữ lại chỉ tổ khiến
        // lần khởi động sau lặp lại đúng phán quyết này.
        await forgetQuietly(persistence, record.id);
        break;
      case 'discard':
        plan.discarded.push({ id: verdict.id, reason: verdict.reason });
        await forgetQuietly(persistence, verdict.id);
        break;
    }
  }

  return plan;
}
