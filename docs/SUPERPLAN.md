# SUPER PLAN — Down Faster → Production

Mục tiêu: đưa repo từ hiện trạng (fix chưa merge, 2 lỗi thật chưa sửa, chưa có đóng gói/trang trí) thành bản production trung thực: main xanh trên CI, mọi claim trong README kiểm chứng được, có release v0.2.0 kèm zip, bộ asset store sẵn sàng.

## Hiện trạng đã xác nhận (căn cứ)
- `main` = a59ac7c; nhánh `fix/opfs-capability-probe` có commit `184f35d` (sửa OPFS probe sai ngữ cảnh — 401 test, typecheck sạch, đã chứng minh trong Chromium: 8 kết nối, 100 MiB, byte-exact) — chưa merge, chưa push.
- 2 lỗi thật chưa sửa:
  - **gzip** — `probe()` luôn gửi `Range: bytes=0-0`; Chrome ném `TypeError: Failed to fetch` khi server trả `200 + content-encoding: gzip` → nhánh `isTransportCompressed()` không bao giờ chạy tới; HLS `fetchSegment` cứng đòi `206` và không gửi `Accept-Encoding: identity`. Tác động chế độ auto: hand-back đúng, không mất file; manual: task kẹt `failed`.
  - **race khởi động** — `ensureDocumentContext()` trả về khi document tồn tại, chưa chắc listener engine đã đăng ký (~190 ms); `send()` không ack không retry → `engine:add` trong cửa sổ đó mất hẳn (bản trình duyệt đã bị `cancel()+erase()` rồi). RPC `engine:ping` đã có sẵn nhưng chưa ai dùng.

## Trình tự & các gói công việc

### WP0 — Ổn định trước (chạy ngay chặng đầu)
1. Đưa fix lên main: merge `fix/opfs-capability-probe` → main, push.
2. `.gitignore`: thêm `*.pid` (CI bench viết `testserver.pid` vào gốc repo).
3. README.md + README.vi.md — mục "Limitations": xoá câu sai hiện trạng "It has never run in a browser", thay bằng bảng "Đã kiểm chứng trong Chromium thật" ghi rõ mục nào pass (1, 2, 4, 5, 8, 9, 10), mục nào biết lỗi (3 gzip), mục nào chưa chạy (6–7, 11, 13–21). Không quảng cáo "đã chạy tốt" bao quát.
**Cửa chặn:** typecheck sạch, 401 test pass, CI xanh trên main, README không còn claim sai.

### WP1 — Sửa 2 lỗi còn lại (test-first, TDD)
**1a. Gzip/probe — `src/engine/probe.ts`:** thêm tham số tiêm `fetchImpl`; ranged-GET thất bại hoặc `200 + content-encoding` → probe dự phòng plain GET → `{acceptRanges:false, size:null}` (streaming một luồng); HLS: `Accept-Encoding: identity` trên mọi request segment/key; test-first; E2E: `/gzip/10485760` manual+auto đều byte-exact.
**1b. Race khởi động — `src/background/index.ts` + `src/ui/*.ts`:** dùng `engine:ping` làm cửa chặn (poll tối đa ~2 s, buffered EngineRequest FIFO, xả khi ack đầu); giữ nguyên nhánh Firefox; test-first; E2E: không còn "engine không phản hồi", `engine:add` ngay sau `onCreated` không mất việc, paint đầu manager không rỗng.
**Cửa chặn:** test mới pass, E2E 5 lần chạy liên tiếp đều sạch cảnh báo.

### WP2 — Thiết kế & làm đẹp UI
1. Rò rỉ i18n: `STATE_LABEL` và đơn vị `B/KB/MB/GB/TB`, `/s`, `s/m/h` trong `src/ui/format.ts` hardcode tiếng Việt; khoá `state_*`/`unit_*` đã dịch sẵn nhưng chết. Sửa: `format.ts` nhận `t()` từ i18n, xoá bản hardcode; test i18n mở rộng.
2. Đánh bóng visual nhỏ (empty state manager, tương phản badge, focus ring nhất quán, khoảng cách popup) — giữ token hiện có.
3. Tài liệu thiết kế ngắn: `docs/DESIGN.md` (token, spacing, state colors, a11y contracts).
**Cửa chặn:** UI en/vi không còn chuỗi hardcode lộ ra, ảnh ba màn nhất quán, a11y không vỡ.

### WP3 — Củng cố test
1. Typecheck cả test/ và bench/: thêm `tsconfig.test.json`, CI chạy thêm `tsc -p tsconfig.test.json --noEmit`, sửa lỗi lòi ra.
2. E2E trong repo (chạy local, KHÔNG vào CI): `scripts/e2e/` port từ harness /tmp (launcher, checklist runner, verifier connect `scripts/testserver.mjs`); devDependency `playwright-core` (không tải browser khi `npm ci`); `npm run e2e` guard rõ hướng dẫn `npx playwright install chromium`; README mục "Kiểm thử trình duyệt thật".
3. Lấp các mục checklist còn trống bằng E2E tự động được: 6, 7, 11, 12, 13, 16, 18, 19, 21; mục cần điều kiện thật (14, 15, 17, 20) → thêm endpoint chunked nếu rẻ, còn lại ghi rõ "chỉ kiểm thủ công" trong README + kết quả JSON (`dist/e2e-results.json`).
**Cửa chặn:** `npm run typecheck` phủ cả test/bench; `npm run e2e` chạy được trên máy local (Chromium có sẵn), kết quả lưu thành JSON.

### WP4 — Ý tưởng
- `docs/ROADMAP.md`: backlog ưu tiên (S/M/L × tác động), từ các khoảng trống đã xác nhận: kéo-thả sắp xếp (`engine:reorder` đã có RPC, thiếu UI), chọn chất lượng media (`engine:probe-media` đã có RPC, thiếu UI), UI mirrors rõ ràng, cài đặt theo từng site, đồ thị tốc độ, HLS cache/resume, tiến độ khi size không rõ, preset hẹn giờ, welcome redesign.
- Mở ~6 issue GitHub từ roadmap (label `enhancement`); tạo label `browser-test` còn thiếu (template đã trỏ tới).
**Cửa chặn:** ROADMAP liên kết từ README, mọi issue có mô tả 1 đoạn + definition-of-done.

### WP5 — Trang trí repo
1. Badges: license (MIT), version, `PRs welcome`; CI badge giữ nguyên; căn hàng cho cả 2 README.
2. Ảnh: `docs/assets/demo.gif` (quay thật từ Chromium: popup → thêm URL → 8 kết nối → xong → lượt qua manager) bằng khung chụp từ harness + ffmpeg, nén <1.5 MiB; `docs/assets/og-cover.png` 1200×630 (logo + gradient + tên); link từ cả 2 README.
3. Governance: `CHANGELOG.md` (Keep a Changelog; 0.1.0 + 0.2.0); `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1); template PR (`.github/PULL_REQUEST_TEMPLATE.md`); `dependabot.yml` (npm + github-actions, monthly, ≤10 PR/tuần).
4. GitHub settings qua `gh`: topics (browser-extension, download-manager, download-accelerator, manifest-v3, chromium, firefox-addon, opfs, hls, typescript); label `browser-test`; đóng template issue trùng nếu có.
5. Không phát sinh rác mới từ `npm run build`.
**Cửa chặn:** README cả 2 ngôn ngữ hiển thị ảnh/badges ngay sau khi render, gh release preview không lỗi, dependabot config hợp lệ (dry-run).

### WP6 — Production ship
1. Bump package.json → `0.2.0` + CHANGELOG đầy đủ.
2. Manifest cho store: `author: "BaoBG"`, `homepage_url` vào cả chromium/firefox overlay; **đổi id Firefox** `down-faster@local.dev` → `down-faster@baobao1044.github.io` (bắt buộc trước AMO).
3. Đóng gói: `scripts/package.mjs` → `npm run package`: build prod cả 2 target + zip `release/down-faster-{chromium,firefox}-0.2.0.zip` (zip phẳng, đúng chuẩn CWS/AMO); smoke: `unzip -l` kiểm manifest có mặt.
4. CI/xuất bản: job `check` thêm `npm run package` + upload artifact; workflow `.github/workflows/release.yml`: `on: push: tags: ['v*']` — build, đóng gói, tạo GitHub Release (draft trước) kèm 2 zip, body tóm CHANGELOG.
5. Bộ store: `store/` — `{en,vi}/description.txt`, `whats-new.txt`, screenshot 1280×800 + promo 440×280 (CWS), screenshot theo spec AMO hiện hành — **xác minh spec trước khi render**; `store/privacy-policy.md` ghi URL raw GitHub của `PRIVACY.md`.
6. Tạo tag `v0.2.0` + push (→ workflow chạy Release); verify: CI xanh, Release có 2 zip tải được, `npm run e2e` lần cuối trên máy thật.
7. Bàn giao: `docs/RELEASE.md` — các bước đăng CWS và AMO bằng tay (tài khoản Google/AMO, text từ store/, asset, privacy URL); cảnh báo: 21 mục checklist còn mục thủ công, con số 4.0×/8.0× là từ bench local chứ không phải đo end-to-end trong browser.
**Cửa chặn cuối:** tag tồn tại, Release v0.2.0 có zip + body từ CHANGELOG, CI xanh, mọi claim README đối chiếu kết quả E2E, `docs/RELEASE.md` đủ để người ngoài làm tiếp không cần hỏi lại.

## Thứ tự chạy & ai làm
- **Tuần tự bắt buộc:** WP0 → WP1a/1b → (WP2, WP3, WP4 song song sau WP1) → WP5 → WP6.
- Mỗi WP dùng subagent theo loại ghi ở trên; WP1 bắt buộc test-first; cuối WP6 chạy `superpowers:verification-before-completion` (bằng chứng trước khi khẳng định).
- Danh sách này được ghi thành `docs/SUPERPLAN.md` ngay sau khi được duyệt, để từng gói công việc giao nguyên văn cho subagent mà không mất ngữ cảnh.
