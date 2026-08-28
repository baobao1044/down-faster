# Hướng dẫn xuất bản (Release Guide)

Bước cuối cùng để đăng Down Faster lên Chrome Web Store và Firefox Add-ons. Đây là việc thủ công, cần tài khoản của bạn.

## Chuẩn bị

1. Đảm bảo `main` đã push và CI xanh.
2. Chạy `npm run package` — tạo 2 zip trong `release/`.
3. Kiểm tra zip: `unzip -l release/down-faster-chromium-0.2.0.zip | head` (manifest.json phải có).

## Chrome Web Store

1. Vào https://chrome.google.com/webstore/devconsole/ (cần tài khoản Google, phí đăng ký $5 một lần).
2. Tạo item mới → upload `release/down-faster-chromium-0.2.0.zip`.
3. Điền:
   - Mô tả: từ `store/en/description.txt` (hoặc `store/vi/` cho tiếng Việt).
   - Danh mục: Productivity.
   - Quyền riêng tư: dán URL `https://github.com/baobao1044/down-faster/blob/main/PRIVACY.md`.
   - Screenshots: cần ít nhất 1 (1280×800 hoặc 640×400). Chưa có — cần chụp thủ công.
   - Promo tile (440×280): tùy chọn, chưa có.
4. Submit for review.

## Firefox Add-ons (AMO)

1. Vào https://addons.mozilla.org/developers/ (cần tài khoản Mozilla).
2. Submit new version → upload `release/down-faster-firefox-0.2.0.zip`.
3. Điền mô tả từ `store/`.
4. Source code: AMO yêu cầu source nếu không biên dịch rõ ràng. Repo GitHub public thỏa mãn — dán URL `https://github.com/baobao1044/down-faster`.
5. Submit for review.

## Cảnh báo trung thực

- 21 mục checklist còn mục thủ công chưa đo (6–7, 11, 13–21).
- Con số 4,0×/8,0× là từ bench local (Node), không phải đo end-to-end trong browser.
- Extension chưa có ai ngoài tác giả dùng thử.
- Chưa có screenshot cho store — cần chụp thủ công.
