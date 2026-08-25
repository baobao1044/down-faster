/**
 * Đo xem bộ dò số kết nối làm lượt tải nhanh lên hay chậm đi.
 *
 * Dùng ĐÚNG `planPieces` và ĐÚNG `ConcurrencyController` của engine, chỉ thay
 * fetch worker bằng vòng lặp trong Node và OPFS bằng một Buffer. Nhờ vậy con số
 * đo được nói về chính thuật toán đang chạy trong extension, không phải về một
 * bản mô phỏng na ná.
 */

import { planPieces, remainingRange, takeNextPending } from '../src/engine/pieces';
import { DEFAULT_OPTIONS } from '../src/engine/types';
import { ConcurrencyController } from '../src/engine/adaptive/concurrency';
import { paceOptionsFor } from '../src/engine/orchestrator';

type Mode = 'fixed' | 'adaptive';

interface Result {
  mode: Mode;
  seconds: number;
  bytes: number;
  peakConnections: number;
  /** Số kết nối được phép, lấy mẫu mỗi 500ms — cho thấy đường leo của bộ dò. */
  ramp: number[];
  corrupt: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function run(
  mode: Mode,
  url: string,
  size: number,
  connections: number,
): Promise<Result> {
  const pieces = planPieces(size, { ...DEFAULT_OPTIONS, connections });
  const out = Buffer.alloc(size);

  // Lấy thẳng cấu hình mà engine dùng, không chép lại: bản chép sẽ lệch đúng vào
  // lúc engine đổi, và số đo khi đó nói về một thuật toán không ai chạy.
  const pace =
    mode === 'adaptive'
      ? new ConcurrencyController(
          paceOptionsFor({ ...DEFAULT_OPTIONS, connections }, pieces.length),
        )
      : null;

  const inflight = new Set<number>();
  let peak = 0;
  let finished = false;
  const ramp: number[] = [];

  const allowance = (): number =>
    pace ? Math.min(connections, pace.allowedAt(Date.now())) : connections;

  // Đúng nhịp mà orchestrator dùng: 500ms một lần, và chính nó đóng cửa sổ đo.
  const ticker = setInterval(() => {
    if (!pace) {
      ramp.push(connections);
      return;
    }
    const now = Date.now();
    pace.noteActive(inflight.size, now);
    pace.tick(now);
    ramp.push(pace.limit);
  }, 500);

  async function fetchPiece(index: number, pieceIndex: number): Promise<void> {
    const piece = pieces[pieceIndex]!;
    const { start, end } = remainingRange(piece);
    const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
    if (!res.body) throw new Error(`piece ${pieceIndex}: không có body`);

    let offset = start;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      Buffer.from(chunk).copy(out, offset);
      offset += chunk.byteLength;
      piece.received += chunk.byteLength;
      pace?.noteBytes(chunk.byteLength, Date.now());
    }
    piece.state = 'done';
    void index;
  }

  async function worker(index: number): Promise<void> {
    for (;;) {
      if (finished) return;
      // Ngoài hạn mức thì ngồi chờ, đúng như worker rảnh trong orchestrator:
      // nó không chết, chỉ không được phát việc cho tới khi bộ dò nới ra.
      if (index >= allowance()) {
        // Hết piece thì thôi chờ. Thiếu nhánh này là treo: lượt tải xong trước
        // khi bộ dò kịp nới tới worker cuối, và nó ngồi đợi một lượt việc
        // không bao giờ tới nữa.
        if (!pieces.some((p) => p.state === 'pending')) return;
        await sleep(100);
        continue;
      }
      const piece = takeNextPending(pieces);
      if (!piece) return;

      inflight.add(index);
      peak = Math.max(peak, inflight.size);
      try {
        await fetchPiece(index, piece.index);
      } finally {
        inflight.delete(index);
      }
    }
  }

  const started = Date.now();
  await Promise.all(Array.from({ length: connections }, (_, i) => worker(i)));
  finished = true;
  clearInterval(ticker);
  const seconds = (Date.now() - started) / 1000;

  let corrupt = 0;
  for (let i = 0; i < size; i++) if (out[i] !== i % 251) corrupt += 1;

  return { mode, seconds, bytes: size, peakConnections: peak, ramp, corrupt };
}

/* ---------- Chạy ---------- */

const base = process.argv[2] ?? 'http://localhost:8787';
const cases: Array<{ label: string; size: number; kbps: number }> = [
  { label: '4 MB', size: 4 * 1024 * 1024, kbps: 500 },
  { label: '32 MB', size: 32 * 1024 * 1024, kbps: 2000 },
];

console.log('Mỗi kết nối bị bóp riêng, trần 8 kết nối.\n');

for (const c of cases) {
  const url = `${base}/slow/${c.size}?kbps=${c.kbps}`;

  // Mốc so sánh thật sự của cả dự án: một kết nối, tức là đúng cách trình duyệt
  // tự tải. Mọi con số "nhanh gấp N lần" phải quy về đây, không phải quy về một
  // cấu hình đa luồng khác.
  const single = await run('fixed', url, c.size, 1);
  const rows: Result[] = [];
  for (const mode of ['fixed', 'adaptive'] as Mode[]) {
    rows.push(await run(mode, url, c.size, 8));
  }

  const [fixed, adaptive] = rows as [Result, Result];
  const delta = ((adaptive.seconds / fixed.seconds - 1) * 100).toFixed(0);

  console.log(`${c.label} @ ${c.kbps} KB/s mỗi kết nối`);
  console.log(
    `  1 kết nối (trình duyệt tự tải)  ${single.seconds.toFixed(2)}s  ` +
      `${single.corrupt === 0 ? 'đúng từng byte' : `SAI ${single.corrupt} byte`}`,
  );
  for (const r of rows) {
    const label = r.mode === 'fixed' ? 'trần cứng 8 (bản cũ) ' : 'bộ dò AIMD (bản mới)';
    const bad = r.corrupt === 0 ? 'đúng từng byte' : `SAI ${r.corrupt} byte`;
    console.log(
      `  ${label}  ${r.seconds.toFixed(2)}s  đỉnh ${r.peakConnections} kết nối  ${bad}`,
    );
  }
  const gain = (single.seconds / adaptive.seconds).toFixed(1);
  console.log(`  chênh lệch AIMD so với trần cứng: ${Number(delta) >= 0 ? '+' : ''}${delta}%`);
  console.log(`  NHANH GẤP ${gain} LẦN so với một kết nối`);
  console.log(`  đường leo của bộ dò: ${adaptive.ramp.join(' ')}\n`);
}
