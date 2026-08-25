/**
 * Ghép segment HLS thành một file.
 *
 * Quyết định thiết kế quan trọng nhất của cả nhóm nằm ở đây, nên nói thẳng:
 *
 *   - Segment fMP4 (có EXT-X-MAP) được nối THẲNG: init segment mang ftyp+moov, mỗi
 *     segment sau đó là moof+mdat, nên nối lại đã là một fragmented MP4 hợp lệ. Không
 *     cần remux, không mất mát, và đây là dạng chiếm đa số HLS hiện đại — tức đường
 *     phổ biến nhất cho ra kết quả hoàn hảo với chi phí bằng không.
 *   - Segment MPEG-TS được nối thành .ts và ta nói rõ giới hạn. Viết một muxer TS→MP4
 *     đúng đắn phải đọc PAT/PMT, gỡ PES, dựng lại SPS/PPS từ Annex-B rồi sinh bảng moov
 *     (stts/stsc/stco/ctts) — đó là một dự án riêng, và một muxer viết vội sẽ đẻ ra file
 *     hỏng một cách lặng lẽ, tệ hơn hẳn một file .ts mà VLC/mpv phát được ngay.
 *
 * Chỗ cắm cho ffmpeg.wasm được để sẵn ở interface `Remuxer` + `registerRemuxer()`.
 * `planAssembly()` tự tra registry, nên ngày nào có muxer thật thì cả đường tải lẫn
 * tên file tự nâng cấp mà không phải sửa gì ở đây.
 *
 * Module cố tình không import `platform/api`: URL của writer worker do bên gọi truyền
 * vào, nhờ vậy phần lập kế hoạch test được mà không cần môi trường extension.
 */

import {
  containerExtension,
  containerMime,
  type MediaPlaylist,
  type SegmentContainer,
} from './playlist';
import type { WriteAck, WriteRequest, WriterCommand, WriterEvent } from '../../shared/protocol';

export type OutputContainer = 'mp4' | 'ts' | 'aac' | 'mp3' | 'bin';

export interface AssemblyPlan {
  container: SegmentContainer;
  output: OutputContainer;
  mimeType: string;
  /** Gồm cả dấu chấm, ví dụ '.mp4'. */
  extension: string;
  /** false nghĩa là phải qua muxer mới ra file đúng định dạng đích. */
  directConcat: boolean;
  /** Tiếng Việt, hiển thị thẳng cho người dùng TRƯỚC khi họ chờ xong vài GB. */
  warnings: string[];
  /** Khác null nghĩa là không tải được, và câu này nói rõ vì sao. */
  blocker: string | null;
}

export interface PlanOptions {
  /** Variant đã chọn có rendition âm thanh nằm ở luồng riêng hay không. */
  separateAudio: boolean;
  /** Đây là luồng audio-only tải kèm cho video câm. */
  audioOnly?: boolean;
}

/* ---------- Chỗ cắm muxer tương lai ---------- */

export interface RemuxInput {
  /** Tên file trong OPFS `parts/`, không phải đường dẫn đầy đủ. */
  partName: string;
  from: SegmentContainer;
  to: OutputContainer;
  signal?: AbortSignal;
  onProgress?: (ratio: number) => void;
}

export interface RemuxOutput {
  partName: string;
  mimeType: string;
}

export interface Remuxer {
  readonly name: string;
  supports(from: SegmentContainer, to: OutputContainer): boolean;
  remux(input: RemuxInput): Promise<RemuxOutput>;
}

let activeRemuxer: Remuxer | null = null;

export function registerRemuxer(remuxer: Remuxer | null): void {
  activeRemuxer = remuxer;
}

export function getRemuxer(): Remuxer | null {
  return activeRemuxer;
}

/* ---------- Lập kế hoạch ---------- */

const OUTPUT_OF: Record<SegmentContainer, OutputContainer> = {
  fmp4: 'mp4',
  mpegts: 'ts',
  aac: 'aac',
  mp3: 'mp3',
  webvtt: 'bin',
  unknown: 'bin',
};

/**
 * Những lý do khiến phép nối thẳng cho ra file hỏng. Mảng rỗng nghĩa là nối được.
 *
 * Tách riêng khỏi `planAssembly` vì đây là phần thuần logic đáng test nhất: mỗi mục
 * trong danh sách này tương ứng với một kiểu file hỏng thật đã gặp ngoài đời.
 */
export function validateForConcat(media: MediaPlaylist): string[] {
  const problems: string[] = [];

  if (media.initSegments.length > 1) {
    problems.push(
      `Playlist dùng ${media.initSegments.length} init segment khác nhau (thường là do ghép quảng cáo hoặc đổi độ phân giải giữa chừng). Nối thẳng sẽ cho ra file chỉ phát được đoạn đầu.`,
    );
  }

  if (media.container === 'unknown') {
    problems.push(
      'Không nhận ra định dạng segment của playlist này, nên không dám nối liều thành một file.',
    );
  }

  if (media.container === 'webvtt') {
    problems.push('Đây là luồng phụ đề chứ không phải video — chưa hỗ trợ tải phụ đề.');
  }

  for (const method of media.encryption) {
    if (method === 'SAMPLE-AES') {
      problems.push(
        'Video mã hóa kiểu SAMPLE-AES — chưa hỗ trợ, vì phải hiểu cấu trúc từng khung hình mới giải được.',
      );
    } else if (method === 'UNKNOWN') {
      problems.push('Playlist dùng kiểu mã hóa lạ mà extension chưa biết cách giải.');
    }
  }

  return problems;
}

export function planAssembly(media: MediaPlaylist, options: PlanOptions): AssemblyPlan {
  const container = media.container;
  const warnings: string[] = [];

  let output = OUTPUT_OF[container];
  let extension = containerExtension(container);
  let mimeType = containerMime(container);
  let directConcat = container !== 'unknown' && container !== 'webvtt';

  // Nếu có muxer thật được cắm vào thì nâng cấp đích luôn — nhờ vậy interface
  // Remuxer là chỗ cắm sống chứ không phải một lời hứa để đó.
  const remuxer = getRemuxer();
  if (container === 'mpegts' && remuxer?.supports('mpegts', 'mp4')) {
    output = 'mp4';
    extension = '.mp4';
    mimeType = 'video/mp4';
    directConcat = false;
    warnings.push(`Sẽ chuyển sang MP4 bằng ${remuxer.name} sau khi tải xong.`);
  } else if (container === 'mpegts') {
    warnings.push(
      'File kết quả là .ts (MPEG-TS) chưa qua chuyển đổi. VLC, mpv và hầu hết trình phát mở được ngay, nhưng Windows Media Player, QuickTime và ứng dụng Ảnh của iPhone thì không.',
    );
  }

  if (options.separateAudio && !options.audioOnly) {
    warnings.push(
      'Video này để tiếng ở một luồng riêng, nên file video tải về sẽ KHÔNG có tiếng. Phần tiếng được tải thành file thứ hai; ghép hai file lại bằng ffmpeg hoặc mở cùng lúc trong trình phát hỗ trợ.',
    );
  }

  if (options.audioOnly) {
    warnings.push('Đây là file tiếng đi kèm, không có hình.');
  }

  if (media.hasDiscontinuity) {
    warnings.push(
      'Playlist có điểm gián đoạn (thường là quảng cáo chèn giữa). Nội dung vẫn được tải đủ, nhưng vài trình phát có thể trục trặc lúc tua qua chỗ đó.',
    );
  }

  const gaps = media.segments.filter((s) => s.gap).length;
  if (gaps > 0) {
    warnings.push(`Server báo trước ${gaps} đoạn bị thiếu; những đoạn đó sẽ bỏ trống trong file.`);
  }

  // Live bị chặn ngay chứ không tải một phần: danh sách còn đang mọc nên không có
  // điểm dừng tự nhiên, và task yêu cầu rõ là đừng treo.
  let blocker: string | null = null;
  if (media.isLive) {
    blocker =
      'Đây là luồng phát trực tiếp (playlist chưa kết thúc), chưa hỗ trợ ghi hình. Hãy thử lại khi buổi phát đã kết thúc và có bản lưu.';
  } else {
    const problems = validateForConcat(media);
    if (problems.length > 0) blocker = problems.join(' ');
  }

  return { container, output, mimeType, extension, directConcat, warnings, blocker };
}

/* ---------- Ghi xuống OPFS ---------- */

/** Tách phần dữ liệu thật ra một ArrayBuffer chuyển nhượng được. */
function toTransferable(chunk: Uint8Array): ArrayBuffer {
  const whole = chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength;
  return whole ? (chunk.buffer as ArrayBuffer) : (chunk.slice().buffer as ArrayBuffer);
}

/**
 * Ghi nối tiếp vào một file OPFS, dùng lại nguyên `writer-worker` có sẵn.
 *
 * Không đẻ worker mới và không sửa `shared/protocol.ts`: mở với `size: 0` (writer chỉ
 * `truncate` khi size > 0, còn `handle.write(buf, {at})` tự nới file), gắn một
 * MessagePort bằng lệnh `attach`, rồi bắn `{offset, buffer}` với offset chạy dần.
 * Ràng buộc "một writer độc quyền" của createSyncAccessHandle nhờ vậy vẫn nguyên vẹn.
 *
 * `append()` chờ biên nhận rồi mới trả về — đó chính là van điều áp về đĩa, đúng
 * cùng cơ chế mà fetch-worker dùng, chỉ khác là ở đây nó nằm ở phía người gọi.
 */
export class SequentialPartWriter {
  private worker: Worker | null = null;
  private port: MessagePort | null = null;
  private offset = 0;
  private closed = false;
  private failure: Error | null = null;
  /** Hàng chờ FIFO các lời hứa append; MessagePort giữ đúng thứ tự nên khớp một-một. */
  private readonly acks: Array<(bytes: number) => void> = [];

  constructor(
    private readonly partFileName: string,
    private readonly writerWorkerUrl: string,
  ) {}

  get written(): number {
    return this.offset;
  }

  open(): Promise<void> {
    if (this.worker) return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
      const worker = new Worker(this.writerWorkerUrl, { type: 'module' });
      this.worker = worker;
      let opened = false;

      worker.onmessage = (event: MessageEvent<WriterEvent>) => {
        const msg = event.data;
        if (msg.type === 'ready') {
          const channel = new MessageChannel();
          this.port = channel.port2;
          channel.port2.onmessage = (ack: MessageEvent<WriteAck>) => {
            this.acks.shift()?.(ack.data.written);
          };
          channel.port2.start();
          worker.postMessage({ type: 'attach' } satisfies WriterCommand, [channel.port1]);
          opened = true;
          resolve();
        } else if (msg.type === 'error') {
          const err = new Error(`Lỗi ghi file tạm: ${msg.message}`);
          this.failure = err;
          if (!opened) {
            // Lỗi TRƯỚC khi có 'ready' nghĩa là không mở nổi file tạm (OPFS bị chặn
            // trong cửa sổ riêng tư, hết quota, tên file đang bị handle khác giữ).
            // `onerror` của Worker không bắt được ca này vì worker vẫn sống và chỉ
            // gửi một thông điệp lỗi. Chỉ ghi nhớ rồi thôi thì lời hứa này treo vĩnh
            // viễn, và job đứng im ở trạng thái 'probing' — người dùng nhìn thấy một
            // lượt tải không bao giờ nhúc nhích cũng không bao giờ báo hỏng.
            this.dispose();
            reject(err);
            return;
          }
          // Sau khi đã mở: lệnh ghi vẫn nhận được biên nhận nên lỗi sẽ trôi qua im
          // lặng; nhớ lại để lần append kế tiếp ném ra.
        }
      };
      worker.onerror = (e) => {
        const err = new Error(e.message || 'Writer worker gặp lỗi');
        this.failure = err;
        this.drainWaiters();
        reject(err);
      };

      worker.postMessage({
        type: 'open',
        fileName: this.partFileName,
        // size 0 để writer không truncate: với HLS ta không biết trước tổng độ dài.
        size: 0,
      } satisfies WriterCommand);
    });
  }

  append(chunk: Uint8Array): Promise<number> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.closed) return Promise.reject(new Error('File tạm đã đóng'));
    const port = this.port;
    if (!port) return Promise.reject(new Error('Chưa mở được file tạm'));
    if (chunk.byteLength === 0) return Promise.resolve(this.offset);

    const buffer = toTransferable(chunk);
    const length = buffer.byteLength; // Phải đọc trước khi chuyển nhượng.
    const at = this.offset;
    this.offset += length;

    return new Promise<number>((resolve, reject) => {
      this.acks.push(() => {
        if (this.failure) reject(this.failure);
        else resolve(this.offset);
      });
      try {
        port.postMessage({ offset: at, buffer } satisfies WriteRequest, [buffer]);
      } catch (err) {
        this.acks.pop();
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  close(): Promise<number> {
    const worker = this.worker;
    if (!worker || this.closed) return Promise.resolve(this.offset);
    this.closed = true;

    return new Promise<number>((resolve) => {
      let settled = false;
      const done = (size: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.dispose();
        resolve(size);
      };

      worker.onmessage = (event: MessageEvent<WriterEvent>) => {
        const msg = event.data;
        if (msg.type === 'closed') done(msg.size);
        else if (msg.type === 'error') done(this.offset);
      };
      worker.postMessage({ type: 'close' } satisfies WriterCommand);
      // Đừng để việc đóng file treo cả job nếu worker mất phản hồi.
      const timer = setTimeout(() => done(this.offset), 5000);
    });
  }

  dispose(): void {
    this.drainWaiters();
    this.port?.close();
    this.port = null;
    this.worker?.terminate();
    this.worker = null;
    this.closed = true;
  }

  /** Nhả mọi append đang chờ, nếu không chúng treo mãi khi worker chết. */
  private drainWaiters(): void {
    const pending = this.acks.splice(0, this.acks.length);
    for (const resolve of pending) resolve(0);
  }
}

/* ---------- Sắp xếp lại thứ tự ---------- */

/** Bên nhận chunk. Tách ra để test thay được writer thật bằng một mảng trong RAM. */
export interface ChunkSink {
  append(chunk: Uint8Array): Promise<number>;
}

export interface OrderedSinkOptions {
  maxBufferedBytes: number;
  total: number;
}

/**
 * Segment tải song song nên hoàn thành lộn xộn, nhưng phải ghi đúng thứ tự.
 *
 * Không thể tính offset trước như engine tải file thường: độ dài mỗi segment chỉ biết
 * sau khi tải xong (và với segment mã hóa thì còn sau khi giải mã và bóc padding).
 * Giữ segment xong sớm trong RAM tới lượt nó là cách duy nhất không phải ghi đĩa hai
 * lần. Trần `maxBufferedBytes` biến áp lực RAM thành áp lực điều tiết: `hasRoom` tắt
 * đi thì bên gọi ngừng phát segment mới.
 */
export class OrderedSink {
  private readonly pending = new Map<number, Uint8Array>();
  /** Chunk đã rời hàng chờ nhưng còn đang trên đường xuống đĩa — vẫn chiếm RAM thật. */
  private inFlight: Uint8Array | null = null;
  private next = 0;
  private chain: Promise<void> = Promise.resolve();
  private failure: Error | null = null;
  /** Tăng lên mỗi lần reset để một lượt drain đang dở tự bỏ cuộc. */
  private epoch = 0;

  constructor(
    private readonly sink: ChunkSink,
    private readonly options: OrderedSinkOptions,
  ) {}

  get hasRoom(): boolean {
    return this.bufferedBytes < this.options.maxBufferedBytes;
  }

  get nextIndex(): number {
    return this.next;
  }

  /**
   * Cộng lại từ chính các chunk đang giữ, thay vì nuôi một biến đếm.
   *
   * Biến đếm là chỗ mọi lỗi kế toán chui vào: đặt lại cùng một index, một lượt drain
   * cũ trừ đi sau khi reset() đã kéo về 0, một chunk bị bỏ vì con trỏ đã vượt qua nó.
   * Mỗi lần lệch là trần đệm co lại vĩnh viễn, và co đủ nhiều thì `hasRoom` tắt hẳn
   * còn hàng đợi bị bóp về đúng một runner. Bản đồ chỉ giữ vài chục phần tử (trần
   * chia cho cỡ một segment) nên cộng lại mỗi lần rẻ hơn hẳn một lớp bug.
   */
  get bufferedBytes(): number {
    let sum = this.inFlight?.byteLength ?? 0;
    for (const chunk of this.pending.values()) sum += chunk.byteLength;
    return sum;
  }

  get done(): boolean {
    return this.next >= this.options.total;
  }

  put(index: number, data: Uint8Array): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    // Segment đã ghi rồi thì bỏ qua: có thể là hàng đợi phát trùng sau một lần reset.
    if (index < this.next) return Promise.resolve();

    // Cùng một segment có thể được đặt lại sau một lần thử lại hoặc một lần reset.
    // Bản sau thắng, bản trước rơi khỏi bản đồ nên cũng thôi tính vào trần đệm.
    this.pending.set(index, data);

    const epoch = this.epoch;
    const run = this.chain.then(() => this.drain(epoch));
    // Giữ dây chuyền luôn ở trạng thái đã giải quyết để một lỗi không làm kẹt
    // vĩnh viễn mọi lời gọi sau; lỗi thật được nhớ ở this.failure.
    this.chain = run.catch(() => {});
    return run;
  }

  private async drain(epoch: number): Promise<void> {
    for (;;) {
      if (epoch !== this.epoch) return;

      // Mục nằm dưới con trỏ là rác của một lượt đã bị hủy: lượt cũ vẫn phải nhích
      // con trỏ qua chunk nó vừa ghi xong, nên nó có thể vượt qua một mục mà lượt mới
      // vừa đặt vào. Không dọn thì mục đó nằm lại mãi và chiếm chỗ trong trần đệm.
      for (const index of [...this.pending.keys()]) {
        if (index < this.next) this.pending.delete(index);
      }

      const chunk = this.pending.get(this.next);
      if (!chunk) return;
      this.pending.delete(this.next);
      this.inFlight = chunk;

      try {
        await this.sink.append(chunk);
      } catch (err) {
        this.failure = err instanceof Error ? err : new Error(String(err));
        this.inFlight = null;
        throw this.failure;
      }
      this.inFlight = null;

      // Con trỏ phải nhích lên KỂ CẢ khi lượt này đã cũ: byte đã nằm trên đĩa rồi, và
      // giả vờ là chưa ghi sẽ khiến lần tiếp tục ghi chồng đúng segment đó lần nữa.
      this.next += 1;
      if (epoch !== this.epoch) return;
    }
  }

  /** Nhả RAM khi tạm dừng hoặc hủy. Phần đã ghi xuống đĩa vẫn giữ nguyên. */
  reset(fromIndex: number): void {
    this.epoch += 1;
    this.pending.clear();
    this.next = Math.max(0, fromIndex);
    this.failure = null;
    // CỐ TÌNH không đặt lại this.chain. Một lượt drain của thế hệ trước hoàn toàn có
    // thể đang nằm giữa `await sink.append()`; vứt dây chuyền đi là cho phép lượt mới
    // gọi append song song với nó. Hai lời gọi chồng nhau thì SequentialPartWriter cấp
    // cho mỗi lời gọi một offset khác nhau, và kết quả là cùng một segment nằm hai lần
    // trong file còn segment kế tiếp thì biến mất. Dây chuyền là thứ duy nhất giữ cho
    // các lần ghi nối đuôi nhau qua một lần tạm dừng.
  }
}
