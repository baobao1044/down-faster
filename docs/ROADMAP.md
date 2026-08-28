# ROADMAP — Down Faster

Đây là backlog tính năng của Down Faster, rút từ các khoảng trống đã xác nhận trong
quá trình khám phá codebase (xem [`SUPERPLAN.md`](./SUPERPLAN.md), mục WP4). Nó liệt kê
những việc có thể làm tiếp, sắp theo tỷ lệ *tác động / công sức*, kèm bằng chứng về
những gì đã có sẵn (RPC, code riêng) và những gì còn thiếu. **Đây là danh sách tham
khảo, không phải cam kết** — không có lịch phát hành nào gắn với các mục dưới đây, và
thứ tự ưu tiên có thể đổi khi có người dùng thật báo lại (qua issue template
`browser-test-report`). Mỗi mục ghi rõ kích thước (S ≤ 1 ngày, M ≤ 1 tuần, L ≤ 1 tháng),
tác động (Low/Medium/High), cái đã có, cái cần làm, và tiêu chí xong.

## Tóm tắt ưu tiên

| # | Tính năng | Size | Impact | Lý do ưu tiên |
|---|-----------|------|--------|---------------|
| 1 | Kéo-thả sắp xếp hàng đợi | S | Medium | RPC `engine:reorder` đã có, chỉ thiếu UI |
| 2 | Chọn chất lượng video/media | M | High | RPC `engine:probe-media` đã có, trả variants sẵn sàng |
| 3 | UI mirrors rõ ràng (dán nhiều URL) | S | Medium | Code đã chạy, chỉ ẩn — cần để người dùng thấy |
| 4 | Tiến độ khi kích thước không rõ | S | Medium | `Progress.size` đã là `null`-able, chỉ thiếu hiển thị |
| 5 | Đồ thị tốc độ tải | M | Medium | `Progress.speed` đã có, cần sample + vẽ |
| 6 | Welcome page redesign | M | Low–Medium | Trang đã có, cần nâng cấp onboarding |
| 7 | Cài đặt theo từng site | L | Medium | Settings hiện chỉ toàn cục, cần store theo host |
| 8 | HLS cache/resume sau khởi động lại | L | Medium–High | `HlsJob` không có persist/resume, chỉ DownloadJob có |
| 9 | Preset hẹn giờ | M | Low | `ScheduleWindow` đã có, thiếu mẫu đặt tên |

## Chi tiết backlog

### 1. Kéo-thả sắp xếp hàng đợi — Size S · Impact Medium
**Đã có:** RPC `engine:reorder` (`src/shared/rpc.ts`), `DownloadManager.reorder()` và
`Queue.reorder()` (`src/engine/manager.ts:259`, `src/engine/queue.ts`), cùng
`engine:front` / `engine:priority` để đẩy lên / đặt ưu tiên. UI hiện chỉ có nút
"Move to front", không có kéo-thả.
**Cần làm:** ô hàng đợi trong `src/ui/manager.html`/`manager.ts` cho phép kéo-thả để
đổi thứ tự, gọi `engine:reorder` với mảng id mới; hỗ trợ bàn phím (mũi tên lên/xuống
khi focus) cho a11y; bám theo token trong `style.css`.
**Tiêu chí xong:**
- Kéo một task xuống dòng khác → thứ tự trên UI và trong `engine:list` khớp nhau sau
  lần thả đầu tiên.
- Có thể đổi thứ tự chỉ bằng bàn phím (Tab tới task, mũi tên, Enter), đọc được bằng
  screen reader.

### 2. Chọn chất lượng video/media — Size M · Impact High
**Đã có:** RPC `engine:probe-media` (`src/shared/rpc.ts:32`) gọi
`DownloadManager.probeMedia()` → `probeMedia()` trong `src/engine/hls/index.ts:259`,
trả `MediaProbe` kèm `variants: VariantSummary[]` (mỗi variant có `label` dạng
"1920×1080 · 6,2 Mbps", `bandwidth`, `height`, `hasSeparateAudio`). RPC
`engine:add-media` nhận `maxHeight` để giới hạn độ phân giải. Popup
(`src/ui/popup.ts`) đã gọi `engine:add-media` nhưng không bao giờ probe trước.
**Cần làm:** khi dán URL trông như media (hoặc nhấn nút "chọn chất lượng"), gọi
`engine:probe-media`, hiển thị danh sách variants cho người dùng chọn, rồi gọi
`engine:add-media` với `maxHeight` (hoặc variant uri) tương ứng; i18n cho nhãn và
trạng thái "đang dò", "không hỗ trợ DASH", "luồng live".
**Tiêu chí xong:**
- Dán một URL master playlist `.m3u8` → thấy danh sách variant, chọn 720p → tải đúng
  variant đó (xác nhận qua log `[df:hls]`).
- URL không phải media hoặc là `.mpd` → hiện thông báo rõ (dựa `MediaProbe.blocker`),
  không treo.

### 3. UI mirrors rõ ràng (dán nhiều URL) — Size S · Impact Medium
**Đã có:** ô URL trong manager là `<textarea>` (`src/ui/manager.html:34`);
`submit()` trong `src/ui/manager.ts:253` tách từng dòng, dòng đầu là nguồn chính,
các dòng sau là mirrors, và gửi qua `engine:add` với field `mirrors`. Chức năng chạy
được nhưng hoàn toàn ẩn — không có gợi ý, placeholder, hay nút nào cho biết cách này
tồnn tại.
**Cần làm:** thêm placeholder/hint trên ô URL ("dán mỗi link một dòng, dòng đầu là
nguồn chính, các dòng sau là mirror"), có thể thêm nút "thêm mirror" tùy chọn;
i18n; giữ phím tắt Enter gửi / Shift+Enter xuống dòng.
**Tiêu chí xong:**
- Placeholder (hoặc hint) giải thích cơ chế mirror, dịch sang cả `en` và `vi`.
- Dán 3 dòng → log/`/stats` cho thấy mirrors được ghi nhận cho task (không phải 3 task
  riêng).

### 4. Tiến độ khi kích thước không rõ — Size S · Impact Medium
**Đã có:** `Progress.size: number | null` (`src/engine/types.ts:103`) đã phân biệt
"không biết size"; `received` và `speed` luôn được theo dõi; setting
`allowStreaming` cho phép tải khi server không báo size; path streaming đơn luồng đã
tồn tại trong orchestrator. UI (manager) hiện vẽ thanh tiến độ theo phần trăm, giả
định `size` không null.
**Cần làm:** khi `Progress.size === null`, chuyển thanh tiến độ sang trạng thái không
xác định (indeterminate) và hiển thị "đã nhận X · tốc độ Y/s" thay vì phần trăm;
thêm khoá i18n `progress_unknown_size`; đảm bảo resume trên ngắt kết nối vẫn đúng.
**Tiêu chí xong:**
- Tải một URL chunked / không có `content-length` → thanh không hiện % sai, mà hiện
  byte đã nhận + tốc độ, và không nhảy về 0 khi resume.

### 5. Đồ thị tốc độ tải — Size M · Impact Medium
**Đã có:** `Progress.speed` (byte/giây tức thời) được orchestrator ước lượng và đẩy
về UI mỗi tick (`src/engine/orchestrator.ts:942`); `format.ts` đã format đơn vị.
Chưa có lưu mẫu lịch sử hay vẽ đồ thị ở đâu.
**Cần làm:** giữ ring buffer mẫu tốc độ (ở UI hoặc engine), vẽ sparkline/đồ thị nhỏ
trong dòng task (hoặc panel chi tiết) bằng SVG/canvas thuần (không thêm dependency);
trục thời gian, tooltip giá trị; tôn trọng token màu trong `style.css`.
**Tiêu chí xong:**
- Khi một task đang tải, dòng đó hiện đồ thị tốc độ cập nhật theo thời gian thực;
  dừng task → đồ thị đóng băng (không nhảy loạn).

### 6. Welcome page redesign — Size M · Impact Low–Medium
**Đã có:** `src/ui/welcome.html` (tiêu đề, intro, 3 gạch đầu dòng, công tắc auto,
nút "Xong"), `src/ui/welcome.ts` chỉ lưu `autoMode` và `onboarded`; style trong
`style.css` `.welcome`.
**Cần làm:** nâng cấp onboarding — giới thiệu nhanh các tính năng chính (auto, mirrors,
media), gợi mở hướng dẫn khởi động (testserver), khớp với token thiết kế sau
`docs/DESIGN.md` (WP2), a11y nhất quán.
**Tiêu chí xong:**
- Trang welcome mới nhất quán với token DESIGN và không còn chuỗi cứng tiếng Việt
  (i18n `en`/`vi` đầy đủ).
- Người dùng mới lần đầu mở extension → thấy trang này, bấm "Xong" → `onboarded`
  được lưu, không mở lại.

### 7. Cài đặt theo từng site — Size L · Impact Medium
**Đã có:** `Settings` (`src/shared/settings.ts`) là toàn cục duy nhất; RPC
`engine:settings` gọi `DownloadManager.applySettings()`. Không có cấu trúc lưu
theo host hay cơ chế merge khi tải từ một host cụ thể.
**Cần làm:** lớp settings theo host (lưu trong `storage.local`), UI thêm/sửa/xóa
quy tắc theo host (số kết nối, giới hạn tốc độ, bật/tắt auto), logic merge
(host-specific đè lên toàn cục) trong engine khi nhận URL, RPC mới nếu cần.
**Tiêu chí xong:**
- Đặt "ví dụ.com: 2 kết nối" → tải file từ ví dụ.com chỉ mở 2 kết nối; file từ host
  khác vẫn theo setting toàn cục.

### 8. HLS cache/resume sau khởi động lại — Size L · Impact Medium–High
**Đã có:** `HlsJob` (`src/engine/hls/index.ts:521`) hỗ trợ `pause`/`resume` trong
phiên, theo dõi state từng segment. Nhưng `src/engine/recovery.ts` và
`persistence.ts` chỉ khôi phục `DownloadJob` theo piece — **không** có persist/
resume cho `HlsJob`: khởi động lại trình duyệt giữa một tải HLS → mất tiến độ.
**Cần làm:** persist tiến độ segment của HLS (index/offset đã xong) vào OPFS/
`storage.local`, khôi phục và tiếp tục từ checkpoint sau restart, dây nối vào
`recovery.ts`, test cho đường dẫn khôi phục.
**Tiêu chí xong:**
- Tải HLS, kill trình duyệt giữa chừng, mở lại → task tiếp tục từ segment đã xong,
  file cuối byte-exact (qua `npm run verify` nếu dùng testserver).

### 9. Preset hẹn giờ — Size M · Impact Low
**Đã có:** `ScheduleController` (`src/engine/schedule.ts:240`), `ScheduleWindow`
{from, to, days}, và `scheduleEditor()` trong `src/ui/manager.ts:425` thêm/xóa cửa
sổ thời gian. Cửa sổ được lưu thô, không có khái niệm mẫu đặt tên (ví dụ "Giờ thấp
điểm", "Ban đêm").
**Cần làm:** thư viện mẫu đặt tên (lưu riêng), nút áp dụng mẫu → sinh
`scheduleWindows`, sửa/xóa mẫu, i18n tên mẫu.
**Tiêu chí xong:**
- Chọn mẫu "Ban đêm" → điền 22:00–06:00 cả tuần; lưu lại → `scheduleWindows` đúng và
  lịch dừng/tiếp theo đúng.

## Known bugs & resolved issues

- **`/gzip` tải hỏng** — **ĐÃ SỬA (resolved).** Probe cũ luôn gửi `Range: bytes=0-0`;
  Chrome ném `TypeError` khi server trả `200 + content-encoding: gzip` → nhánh
  `isTransportCompressed()` không chạy; HLS `fetchSegment` cứng đòi `206`, không gửi
  `Accept-Encoding: identity`. Sửa trong WP1a (nhánh `fix/gzip-probe`, commit
  `ed0babc`): probe dự phòng plain-GET khi ranged fetch ném hoặc gặp `200 +
  content-encoding`, HLS gửi `Accept-Encoding: identity`. Đã merge vào `main` tại
  commit `4fb0760` ("Merge WP1a+WP1b"). Trạng thái: đã sửa trên main.
- **Race khởi động (engine không phản hồi)** — **ĐÃ SỬA (resolved).** `ensureDocumentContext()`
  trả về khi document tồn tại, chưa chắc listener engine đã đăng ký (~190 ms); `send()`
  không ack không retry → `engine:add` trong cửa sổ đó mất hẳn. Sửa trong WP1b (nhánh
  `fix/bootstrap-race`, commit `b1a0bea`): dùng `engine:ping` làm cửa chặn (poll tối đa
  ~2 s) + buffer `EngineRequest` FIFO, xả khi ack đầu. Đã merge vào `main` tại commit
  `4fb0760`. Trạng thái: đã sửa trên main.
- **DASH (.mpd) chưa hỗ trợ** — **OPEN (limitation, không phải regress).**
  `classifyMediaUrl()` nhận ra DASH nhưng `probeMedia()` trả `MediaProbe.blocker`
  ("chưa đọc được định dạng này — hiện chỉ hỗ trợ HLS"). Không phải lỗi mới, là giới hạn
  thiết kế (HLS-only). Khi người dùng thực sự cần DASH, mở issue riêng.

> Ghi chú: kế hoạch WP4 gốc dặn đánh dấu hai lỗi đầu là "in progress" nếu nhánh fix
> còn tồn tại. Thực tế cả `fix/gzip-probe` và `fix/bootstrap-race` đều **đã merge vào
> `main`** (commit `4fb0760`), nên ở đây ghi đúng trạng thái là "đã sửa" thay vì
> "in progress" — bám theo nguyên tắc của dự án: mọi claim phải kiểm chứng được.
