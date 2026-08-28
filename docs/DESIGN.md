# Design system

Tham chiếu ngắn cho người sửa UI. Mọi thứ dưới đây mô tả những gì *thật sự
tồn tại* trong `src/ui/style.css` và `src/ui/a11y.ts` — không phải mục tiêu lý
tưởng. Không thêm token màu mới: dùng đúng 8 biến dưới.

## Token màu

Khai báo ở `:root` (chế độ sáng), ghi đè trong `@media (prefers-color-scheme:
dark)`:

| Token      | Sáng      | Tối       | Mục đích                                    |
|------------|-----------|-----------|---------------------------------------------|
| `--bg`     | `#ffffff` | `#14161a` | Nền trang                                   |
| `--surface`| `#f6f7f9` | `#1c1f25` | Nền thẻ/bảng (`task`, `switch-row`)          |
| `--border` | `#e2e5ea` | `#2c3039` | Viền mảnh, thanh `<progress>`, `.badge.soft`|
| `--text`   | `#16181d` | `#e8eaed` | Chữ chính                                   |
| `--muted`  | `#6b7280` | `#9aa1ab` | Chữ phụ (`.meta`, `.hint`, `.empty`)         |
| `--accent` | `#2563eb` | `#60a5fa` | Hành động chính, link, focus ring, `.badge`  |
| `--danger` | `#dc2626` | `#f87171` | Thất bại, `.state-failed`, `.error`          |
| `--ok`     | `#16a34a` | `#4ade80` | Thành công, `.state-completed`              |

`color-scheme: light dark` đặt ở `:root` để control gốc của trình duyệt tự lặp
theo chế độ. Định dạng số đi qua `Intl.NumberFormat(currentLocale())`, lấy mã
locale từ bảng chuỗi chứ không phải ngôn ngữ giao diện trình duyệt, để chữ và
dấu thập phân khớp nhau.

## Nhịp khoảng cách

Không có hệ thống token khoảng cách chính thức; dùng nhịp 4px: `4, 6, 8, 10,
12, 16, 20, 32`. Quan sát được: `body` padding 16px; `.row` gap 8px; nút padding
8px 12px; `.task` padding 12px, `margin-top` 10px; bo góc 6px (thẻ 8px). Trạng
thái rỗng `.empty` padding 32px 12px cho khoảng thở.

## Màu trạng thái

Nhãn trạng thái (`src/ui/format.ts` `stateLabel`) là chữ thường màu `--muted`
(qua `.meta`). Hai trạng thái có màu riêng, gắn class `state-<tên>` lên phần tử
chứa nhãn:

- `.state-failed` → `--danger` (đỏ).
- `.state-completed` → `--ok` (xanh).
- Các trạng thái còn lại (queued, probing, downloading, paused, assembling,
  canceled) kế thừa `--muted`.

`.badge` (số kết nối, đánh dấu video) dùng nền `--accent`; trong nền tối chữ
chuyển sang `--bg` để giữ tương phản (~6,6:1, vì trắng trên `#60a5fa` chỉ đạt
~2,5:1). `.badge.soft` dùng nền `--border` + chữ `--text`.

## Tương phản và focus

Vành `:focus-visible` nhất quán trên mọi control: `outline: 2px solid
var(--accent); outline-offset: 2px;` — áp cho `button`, các `input` theo type
(url/number/time), `select`, `textarea`, khớp với `.task:focus-visible` và vành
của công tắc (qua `.track`).

## Hợp đồng trợ năng (`src/ui/a11y.ts`)

- **Roving list** (`installRovingList`): mũi tên Lên/Xuống/Home/End di chuyển
  giữa các `.task`; roving tabindex (0 trên hàng đang chọn, -1 trên các hàng còn
  lại). Phím
  Tab tới nút bên trong hàng một cách tự nhiên — cố tình không đặt nút `tabindex
  -1` để người dùng bàn phím không chuyên vẫn tới được. Bấm chuột chọn hàng đó
  làm điểm dừng Tab. Gọi `refresh()` sau mỗi lần vẽ lại. `preserveFocus` cứu
  focus khi hàng dưới con trỏ bị xóa; `focusFirst` đưa focus vào hàng đầu.

- **ProgressAnnouncer / mốc aria-live**: dựng sẵn hai vùng rỗng lúc khởi động
  (`#df-live-polite` `role=status`, `#df-live-assertive` `role=alert`,
  `aria-atomic`), vì trình đọc màn hình chỉ theo dõi vùng live có sẵn từ trước.
  Lõi `milestoneFor` thuần: thay đổi trạng thái luôn đọc; tiến độ chỉ đọc theo
  bậc 25% (`stepPercent`) với giãn cách tối thiểu 15s (`minGapMs`), bỏ qua 0%,
  bỏ qua khi không biết kích thước, và ghi luôn bậc hiện tại làm đã đọc khi đổi
  trạng thái. Thất bại đọc ở mức assertive (cắt ngang), còn lại polite. Lặp cùng
  câu thì xóa rồi đặt lại sau 60ms (`REPEAT_DELAY_MS`) vì vài trình đọc bỏ qua
  nội dung không đổi; hẹn giờ đọc lại tách riêng từng vùng để câu khẩn không hủy
  nhịp chờ của vùng thường. `update` lượt đầu chỉ ghi nhớ, không đọc (tránh đọc
  cả chục câu khi mở trang); gộp: mọi mốc trạng thái trong một nhịp nối bằng
  ". " (assertive nếu có thất bại), còn mốc tiến độ chỉ đọc khi nhịp đó không có
  mốc trạng thái và chỉ cho một lượt.

- **`prefers-reduced-motion`**: CSS tắt mọi `transition`/`animation`. Ngoài ra
  `reflectMotionPreference()` ghi `data-motion="reduced"|"full"` lên `<html>`
  (cần vì `<progress>` không có value chạy hoạt ảnh vô hạn mà media query trong
  CSS không tắt được).

- **`.sr-only`**: ẩn khỏi mắt nhưng vẫn trong cây trợ năng (clip, 1px). Helper
  `visuallyHidden()` đặt style inline để không phụ thuộc `style.css`.

- **`labelControl`**: nối `aria-label`/`aria-labelledby`/`aria-describedby`
  cho control có nhãn ở div anh em (công tắc, ô nhập URL).

- **i18n**: `data-i18n` đặt textContent, `data-i18n-<attr>` theo danh sách trắng
  (không có `href`/`src`/`onclick`), `data-i18n-args` JSON cho tham số.
