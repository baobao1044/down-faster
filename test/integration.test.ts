import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_SETTINGS, toDownloadOptions } from '../src/shared/settings';
import { DEFAULT_OPTIONS } from '../src/engine/types';
import { failureKind, paceOptionsFor } from '../src/engine/orchestrator';
import { compareFingerprints } from '../src/engine/adaptive/mirrors';
import { requireStorage, resetCapabilities } from '../src/platform/capabilities';

/* ---------- Cài đặt tới engine ---------- */

/**
 * Thêm một cài đặt mà quên chuyền nó xuống engine là loại lỗi không ai phát hiện
 * ra: ô tick vẫn bật, vẫn lưu, chỉ là chẳng có tác dụng gì. Test này khóa lại
 * đúng những trường đã hứa.
 */
test('mọi tùy chọn của engine đều được cài đặt lấp đầy', () => {
  const mapped = toDownloadOptions(DEFAULT_SETTINGS);

  assert.equal(mapped.connections, DEFAULT_SETTINGS.connections);
  assert.equal(mapped.maxRetries, DEFAULT_SETTINGS.maxRetries);
  assert.equal(mapped.minAccelerateSize, DEFAULT_SETTINGS.minInterceptSize);
  assert.equal(mapped.adaptiveConnections, DEFAULT_SETTINGS.adaptiveConnections);
  assert.equal(mapped.allowStreaming, DEFAULT_SETTINGS.allowStreaming);
  assert.equal(mapped.replayHeaders, DEFAULT_SETTINGS.replayHeaders);
});

test('cài đặt đổi thì tùy chọn engine đổi theo, không bị đóng băng', () => {
  const mapped = toDownloadOptions({
    ...DEFAULT_SETTINGS,
    connections: 3,
    adaptiveConnections: false,
    allowStreaming: false,
    replayHeaders: 'off',
    minInterceptSize: 123,
  });

  assert.equal(mapped.connections, 3);
  assert.equal(mapped.adaptiveConnections, false);
  assert.equal(mapped.allowStreaming, false);
  assert.equal(mapped.replayHeaders, 'off');
  assert.equal(mapped.minAccelerateSize, 123);
});

test('những trường engine tự lo không bị cài đặt ghi đè', () => {
  const merged = { ...DEFAULT_OPTIONS, ...toDownloadOptions(DEFAULT_SETTINGS) };
  // writeHighWaterMark là chuyện của bộ nhớ, không phải lựa chọn của người dùng.
  assert.equal(merged.writeHighWaterMark, DEFAULT_OPTIONS.writeHighWaterMark);
  assert.equal(merged.minConnections, DEFAULT_OPTIONS.minConnections);
});

/* ---------- Quy lỗi piece về loại sự cố của nguồn ---------- */

test('404 và 410 là nguồn không còn file, không phải lỗi mạng', () => {
  assert.equal(failureKind(404, ''), 'notfound');
  assert.equal(failureKind(410, ''), 'notfound');
});

test('429 và 503 là bị bóp, phải nghỉ chứ không phải loại nguồn', () => {
  assert.equal(failureKind(429, ''), 'throttled');
  assert.equal(failureKind(503, ''), 'throttled');
  assert.equal(failureKind(509, ''), 'throttled');
});

test('408 và 504 là quá hạn chờ', () => {
  assert.equal(failureKind(408, ''), 'timeout');
  assert.equal(failureKind(504, ''), 'timeout');
});

test('server phớt lờ Range là nội dung không khớp, không phải trục trặc tạm thời', () => {
  assert.equal(failureKind(null, 'Server không tôn trọng header Range'), 'mismatch');
  assert.equal(failureKind(null, 'Khoảng byte không hợp lệ (416)'), 'mismatch');
});

test('không rõ nguyên nhân thì coi là lỗi mạng, loại nhẹ nhất', () => {
  assert.equal(failureKind(null, 'socket hang up'), 'network');
  assert.equal(failureKind(500, 'Internal Server Error'), 'network');
});

/* ---------- Điều kiện nhận một nguồn dự phòng ---------- */

/**
 * Orchestrator chỉ nhận nguồn khi phán quyết là 'same'. Ba test dưới đây khóa
 * đúng ranh giới đó: nhận nhầm một bản khác là ghép ra file hỏng mà không báo
 * lỗi gì, thứ tệ hơn hẳn việc bỏ lỡ một nguồn.
 */
const fp = (size: number | null, etag: string | null) => ({
  size,
  etag,
  lastModified: null,
  acceptRanges: true,
});

test('kích thước lệch là bằng chứng chắc chắn hai file khác nhau', () => {
  assert.equal(compareFingerprints(fp(100, null), fp(101, null), false).verdict, 'different');
});

test('ETag mạnh trùng nhau là đủ để nhận ngay, khỏi lấy mẫu nội dung', () => {
  assert.equal(compareFingerprints(fp(100, '"abc"'), fp(100, '"abc"'), false).verdict, 'same');
});

test('ETag yếu chỉ cho ra "likely", tức là phải lấy mẫu nội dung mới dám dùng', () => {
  // W/ chỉ hứa tương đương ngữ nghĩa; chia piece giữa hai bản như vậy là file hỏng.
  assert.equal(compareFingerprints(fp(100, 'W/"abc"'), fp(100, '"abc"'), false).verdict, 'likely');
});

test('thiếu Content-Length thì không kết luận được, và cũng không lấy mẫu được', () => {
  // 'unknown' không leo lên bước lấy mẫu vì sampleDigest cần biết kích thước.
  assert.equal(compareFingerprints(fp(null, null), fp(100, null), false).verdict, 'unknown');
});

/* ---------- Cấu hình bộ dò số kết nối ---------- */

/**
 * Đây là chỗ từng có một hồi quy thật: cho bộ dò khởi đầu ở 2 kết nối làm file
 * 4 MB chậm đi 93% và file 32 MB chậm đi 210%, vì nó chỉ nhích một bậc mỗi ~4
 * giây nên mất chừng 24 giây mới chạm trần — dài hơn hầu hết lượt tải.
 */
test('bộ dò mở thẳng ở trần người dùng đặt, không leo dần từ dưới lên', () => {
  const pace = paceOptionsFor({ ...DEFAULT_OPTIONS, connections: 8 }, 32);
  assert.equal(pace.max, 8);
  assert.equal(pace.start, 8, 'khởi đầu phải bằng trần, nếu không là hồi quy tốc độ');
});

test('trần không bao giờ vượt số piece thật sự có', () => {
  // 4 MB chỉ chia ra 4 piece, mở 8 kết nối là thừa 4 worker ngồi không.
  const pace = paceOptionsFor({ ...DEFAULT_OPTIONS, connections: 8 }, 4);
  assert.equal(pace.max, 4);
  assert.equal(pace.start, 4);
});

test('sàn không được cao hơn trần dù người dùng đặt lệch', () => {
  const pace = paceOptionsFor({ ...DEFAULT_OPTIONS, connections: 2, minConnections: 9 }, 32);
  assert.equal(pace.max, 2);
  assert.equal(pace.min, 2);
});

test('chưa chia piece thì vẫn phải cho chạy một kết nối', () => {
  const pace = paceOptionsFor({ ...DEFAULT_OPTIONS, connections: 8 }, 0);
  assert.equal(pace.max, 1);
  assert.equal(pace.start, 1);
});

/* ---------- Chốt chặn bộ nhớ tạm ---------- */

/**
 * Không có chốt này thì engine đi hết đường thăm dò, chia piece, spawn worker rồi
 * mới chết ở lời gọi createSyncAccessHandle đầu tiên — và ở chế độ tự động thì
 * lượt tải đã bị giành mất khỏi trình duyệt rồi.
 */
test('thiếu OPFS thì chặn ngay, không để engine đi tiếp rồi mới chết', async () => {
  resetCapabilities();
  await assert.rejects(
    () => requireStorage(async () => ({ opfs: false, syncAccessHandle: false, persistentStorage: false })),
    /OPFS/,
  );
});

test('có OPFS nhưng không ghi được theo offset cũng phải chặn', async () => {
  resetCapabilities();
  await assert.rejects(
    () => requireStorage(async () => ({ opfs: true, syncAccessHandle: false, persistentStorage: false })),
    /createSyncAccessHandle/,
  );
});

test('đủ khả năng thì đi tiếp, không ném gì', async () => {
  resetCapabilities();
  await requireStorage(async () => ({ opfs: true, syncAccessHandle: true, persistentStorage: true }));
});

test('chỉ dò một lần cho cả phiên, không tạo file thăm dò mỗi lượt tải', async () => {
  resetCapabilities();
  let calls = 0;
  const detect = async () => {
    calls += 1;
    return { opfs: true, syncAccessHandle: true, persistentStorage: true };
  };
  await requireStorage(detect);
  await requireStorage(detect);
  await requireStorage(detect);
  assert.equal(calls, 1);
});
