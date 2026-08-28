# Bộ E2E Down Faster

Bộ kiểm chứng đầu cuối (end-to-end): mở **Chromium/Chrome thật** có nạp extension
Down Faster, bắn lượt tải qua server test nội bộ, và kiểm tra file tải về khớp
từng byte với mẫu dữ liệu (`byte[i] = i % 251`). Khác với `npm test` (chạy engine
trong Node, không có trình duyệt), bộ này đi hết đường thật: service worker →
offscreen document → fetch worker → OPFS → `chrome.downloads.download` → đĩa.

## Điều kiện trước

1. **`npm install`** — bộ E2E cần `playwright-core` và `@types/node` (đã khai báo
   trong `package.json` devDependencies). Lockfile sẽ cập nhật sau `npm install`.

2. **Chromium/Chrome thật**, một trong:
   - `npx playwright install chromium` (cài vào `~/.cache/ms-playwright/`), hoặc
   - Chrome hệ thống (`/usr/bin/google-chrome`, `/opt/google/chrome/chrome`...), hoặc
   - đặt `CHROME_PATH=/đường/dẫn/tới/chrome`.

   Headless shell thuần (không có engine render) **không** tải được extension.
   Dùng bản Chrome/Chromium đầy đủ.

## Chạy

```sh
npm run e2e
```

`npm run e2e` làm lần lượt:

1. Dựng bản dev (`npm run build:dev`) nếu `dist/chromium/manifest.json` chưa có.
2. Dò binary Chromium/Chrome (theo `CHROME_PATH` → playwright-core → đường dẫn
   hệ thống). Không thấy thì in hướng dẫn rồi thoát 1.
3. Bật `scripts/testserver.mjs` ở nền (cổng 8787) nếu chưa có server nào chạy.
4. Mở Chromium có `--load-extension=dist/chromium`, chờ service worker lên, ping
   engine tới khi sẵn sàng.
5. Chạy từng checklist item, kiểm byte-exact file trong thư mục Downloads.
6. Ghi `dist/e2e-results.json` và in bảng tóm tắt.
7. Tắt testserver (nếu chính bộ E2E đã bật).

Tham số tuỳ chọn (truyền qua `node scripts/e2e/run.mjs ...`):

- `--port=8787` — cổng server test.
- `--browser=/path/to/chrome` — dùng binary này, bỏ qua dò.
- `--headed` — chạy có cửa sổ (gỡ lỗi; cần môi trường có GUI).
- `--timeout=60000` — thời gian chờ mỗi item (ms).

## Các checklist item

Mỗi item gửi `engine:add` với `source: 'manual'` (ép engine xử lý mọi route, kể
cả `/gzip` và `/norange` mà chế độ auto vốn trả lại trình duyệt), thăm dò
`engine:list` tới khi state chốt, rồi kiểm file tải về đúng `i % 251`.

| # | Route | Kiểm tra gì |
|---|-------|-------------|
| 1 | `/file` (1 MiB) | chia 8 luồng Range đầy đủ, byte-exact |
| 2 | `/file` (4 MiB) | file lớn chia luồng, byte-exact |
| 3 | `/slow` (bóp 200 KB/s) | vẫn đúng byte khi từng kết nối bị bóp |
| 4 | `/norange` | không Range → lui 1 luồng, byte-exact |
| 5 | `/gzip` | nén trên đường → cấm chia luồng, byte-exact |
| 8 | `/flaky` (đứt giữa) | đường retry, đúng byte |
| 9 | song song | hai file cùng lúc, cả hai byte-exact |
| 10 | `/named` | Content-Disposition tên tiếng Việt |

## Cấu trúc

- `launch.mjs` — dò binary, mở Chromium + `--load-extension`, gắn log service
  worker / offscreen, `waitForEngineReady` (ping tới khi engine đáp).
- `checklist.mjs` — định nghĩa và chạy các item, kiểm byte-exact, xuất JSON.
- `run.mjs` — điểm vào: dựng nếu thiếu, dò browser, bật server, chạy, báo cáo.

## Lưu ý kỹ thuật

- **Playwright + extension**: Playwright mặc định thêm `--disable-extensions`,
  làm `--load-extension` vô hiệu. `launch.mjs` truyền `ignoreDefaultArgs` để
  bỏ cờ đó, và thêm `--headless=new` (headless cũ không nạp extension MV3).
- **Race khởi động**: service worker lên nhanh, nhưng engine host (offscreen
  document) đăng ký listener bất đồng bộ. `waitForEngineReady` thăm dò
  `engine:ping` tới khi `{ok:true}` trước khi gửi `engine:add` — đúng cơ chế
  ping-gate mà `src/shared/engine-channel.ts` mô tả.
- **File ghi vào Downloads**: engine gọi `chrome.downloads.download({filename})`,
  file vào thư mục tải mặc định của hồ sơ (`~/Downloads`). Bộ E2E dò file theo tên
  trong `~/Downloads` (hoặc `~/Tải xuống`).
