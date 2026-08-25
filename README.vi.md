# Down Faster

**Tiếng Việt** · [English](README.md)

Một extension tải file bằng nhiều request HTTP `Range` song song thay vì một. Chromium
và Firefox, Manifest V3, chung một code base, không cần binary ngoài, không cần app đi kèm.

[![CI](https://github.com/baobao1044/down-faster/actions/workflows/ci.yml/badge.svg)](https://github.com/baobao1044/down-faster/actions/workflows/ci.yml)

`giấy phép: MIT` · `trạng thái: alpha — chưa từng chạy trong browser thật` · `397 test xanh`

*Huy hiệu này có thật, và nó hẹp. Ngay ở commit đầu tiên, GitHub Actions đã chạy bộ test
trên một lần `npm ci` sạch với cả Node 20 lẫn Node 22, cả hai nhánh đều xanh — nên con số
397 không còn chỉ là lời của tác giả nữa. Nhưng thứ huy hiệu KHÔNG bao gồm lại đúng là
thứ quan trọng nhất: Actions chạy Linux không màn hình, không có browser nào, y hệt máy
phát triển. Nó kiểm đúng phần logic thuần và không chạm được vào một đường phụ thuộc
trình duyệt nào. Dấu tick xanh ở đây nghĩa là code biên dịch được và test đơn vị qua.
Nó KHÔNG phải bằng chứng rằng extension chạy được.*

> [!WARNING]
> **Extension này chưa từng chạy trong một trình duyệt thật. Chưa một lần nào.** Máy phát
> triển không cài browser, nên mọi đường phụ thuộc trình duyệt mới chỉ đúng trên giấy và
> qua test đơn vị, chưa ai từng thấy nó chạy: OPFS và `createSyncAccessHandle`, Web
> Worker, offscreen document, `chrome.alarms`, `declarativeNetRequest`,
> `chrome.downloads`, content script.
>
> Phần logic thuần có 397 test xanh, nhưng chính đoạn nối các mảnh đã test đó lại thành
> một lượt tải thật — `DownloadJob` (815 dòng) và `HlsJob` (574 dòng) — thì cũng không có
> test nào. Khoảng 34% `src/` không được test — con số cụ thể ở mục
> [Test phủ tới đâu](#test-phủ-tới-đâu). Chưa ai ngoài tác giả dùng thử, và nó chưa lên
> store nào.
>
> **Chế độ tự động BẬT SẴN, và content script cũng vậy.** `DEFAULT_SETTINGS` trong
> `src/shared/settings.ts` đặt `autoMode: true` *và* `detectMedia: true`. Nghĩa là cài
> xong, không bấm gì cả: extension tự giành **mọi** lượt tải trên 5 MiB, và content script
> dò video chạy trên **mọi** trang bạn mở. Đúng phần mã đi giành đó nằm trong 34% chưa có
> test và chưa từng chạy. Muốn thử an toàn thì tắt hai công tắc này trước khi lướt web
> bình thường: trang quản lý → **Tự động tăng tốc** (tắt), và tab *Cài đặt* → **Tìm video
> trong trang** (tắt).
>
> **Đừng dùng cho việc gì quan trọng.** Hãy coi đây là một thiết kế và một bộ test, tình
> cờ biên dịch ra được hai extension nạp được vào trình duyệt.

---

## Dùng để làm gì

Trình duyệt tải một file bằng một kết nối HTTP. Nhiều server bóp băng thông theo **từng
kết nối** chứ không theo từng client. Khi đúng là như vậy, mở tám kết nối và xin mỗi
kết nối một khoảng byte khác nhau bằng header `Range` sẽ xong cùng file đó nhanh hơn
vài lần.

Mẹo chỉ có thế, và nó cũ rồi. Phần đáng nói là Manifest V3 làm việc cài đặt mẹo này bên
trong một extension trở nên khó, và phần lớn code base này tồn tại để đi vòng qua những
ràng buộc đó chứ không phải để tải file.

## Nguyên lý

Tăng tốc đến từ việc mở nhiều kết nối HTTP song song, mỗi kết nối xin một khoảng byte
khác nhau bằng header `Range`, rồi ghi thẳng vào cùng một file trên đĩa.

```
[ Content script ]  dò video trong trang
              │
[ Service Worker / Event Page ]   bắt lượt tải, lịch, thông báo, luật header
              │                    (nơi DUY NHẤT gọi được API trình duyệt)
              │  HostBridge
[ Offscreen (Chromium) / Event Page (Firefox) ]   engine host
              │   hàng đợi · xô token · chốt sổ tiến độ
   ┌──────────┴───────────┐
[ N fetch worker ]    [ writer worker ]
  Range: bytes=…  ──────>  OPFS, ghi theo offset
                              │
                    chrome.downloads.download()
```

Vài quyết định đáng nói, kèm chỗ đọc code:

**Engine không nằm trong service worker.** MV3 service worker không có DOM, không spawn
được `Worker`, không tạo được blob URL, và bị kill khi rảnh. Trên Chromium engine sống
trong offscreen document (`src/offscreen/offscreen.ts`); trên Firefox event page vốn đã
có DOM nên engine chạy thẳng trong đó. Offscreen document chỉ chắc chắn dùng được
`chrome.runtime`, nên mọi việc đụng tới `downloads`, `storage`, `notifications`,
`action`, `declarativeNetRequest` đều nhờ background làm hộ qua HostBridge.

**Ghi qua OPFS chứ không gom trong RAM.** Ghép chunk trong bộ nhớ sẽ sập ở vài GB.
`createSyncAccessHandle()` cho phép ghi random-access thẳng xuống đĩa. Handle này giữ
khóa độc quyền nên chỉ có đúng một writer worker; các fetch worker đẩy buffer sang nó
qua `MessagePort` bằng transfer nên không phát sinh bản sao.

**Không có OPFS thì không bắt đầu gì cả.** `DownloadJob.openWriter()` — chỗ duy nhất mà
mọi đường tải đi xuống đĩa — gọi và chờ `requireStorage()`
(`src/platform/capabilities.ts`) trước khi dựng writer worker. Trình duyệt không có OPFS,
hoặc có OPFS nhưng thiếu `createSyncAccessHandle`, thì hỏng ngay tại đó, kèm một câu nói
rõ thiếu cái gì, thay vì chết mấy bước sau ở bên trong worker. Ở chế độ tự động đó chính
là khác biệt đáng giá: hỏng sớm như vậy thì `fail()` vẫn còn kịp trả URL gốc về cho trình
duyệt, nên file không bị mất. Việc dò chạy một lần cho cả phiên và kết quả được nhớ lại.
Đây không phải ca giả tưởng: OPFS vắng mặt trong chế độ duyệt riêng tư của một số trình
duyệt.

**Piece nhỏ và nhiều hơn số kết nối.** Chia tĩnh N phần cho N kết nối nghe hợp lý nhưng
hỏng trong thực tế: chỉ cần một kết nối rơi vào node CDN chậm là bảy kết nối kia xong
rồi ngồi chờ. `src/engine/pieces.ts` phát 4 piece cho mỗi kết nối, worker nào rảnh thì
bốc piece kế tiếp, chênh lệch tốc độ tự san phẳng mà không cần đo đạc gì.

**Có điều áp.** Mạng thường nhanh hơn đĩa. Fetch worker chờ biên nhận ghi (write-ack) từ
writer trước khi đọc thêm, giữ lượng dữ liệu chưa ghi dưới ngưỡng cho trước.

**AIMD là cái phanh, không phải bàn đạp.** Lượt tải mở thẳng ở trần người dùng đặt
(`paceOptionsFor()` trong `src/engine/orchestrator.ts` đặt `start = max`), rồi bộ điều
khiển kéo xuống khi server trả 429/503 hoặc gửi `Retry-After`, và nới lại dần sau đó.
Bản đầu làm ngược lại và đo ra chậm hơn hẳn — xem mục [Đo tốc độ](#đo-tốc-độ).

**Xô token chung cho cả extension.** Người dùng đặt "500 KB/s" là nói cho cả extension
chứ không phải cho từng kết nối. Xô nằm ở engine host (`src/engine/throttle.ts`), worker
xin hạn mức theo lô trước khi đọc — sai số vì thế bị chặn ở đúng một lô mỗi worker. Cố
tình không dùng `SharedArrayBuffer` + `Atomics.wait`: chặn vòng lặp message của fetch
worker sẽ khóa chết luôn đường nhận write-ack, mà van điều áp lại đang dựa vào đó.

**Nguồn dự phòng phải chứng minh là cùng một file.** Hai URL người dùng tin là giống
nhau mà thật ra khác nhau sẽ ghép ra file hỏng không báo lỗi gì. Nguồn phụ chỉ vào pool
sau khi khớp ETag mạnh, hoặc khớp mã băm của ba cửa sổ 64 KiB lấy ở đầu, giữa và cuối
file. ETag yếu chỉ được tính là "có khả năng", không đủ để chia piece.
Phân định cho rõ phần nào đã kiểm: **phép phán quyết** có test — `compareFingerprints()`
và `verifyByContent()` trong `src/engine/adaptive/mirrors.ts`, được test trong
`adaptive.test.ts` và `integration.test.ts`. **Thứ tự thi hành** thì chưa: quy tắc giữ
nguồn phụ ở ngoài pool cho tới khi xác minh xong nằm trong `DownloadJob.verifyMirrors()`
(`src/engine/orchestrator.ts:376`), mà `DownloadJob` không có một test nào.

**Bí mật không bao giờ xuống đĩa.** Kho header phát lại (Referer, Cookie) là một `Map`
trong RAM với TTL và LRU (`HeaderStore` trong `src/engine/adaptive/headers.ts`), không
có đường nào ghi nó xuống `chrome.storage`. Có test khóa lại việc không bao giờ gửi
Cookie sang origin khác. Những header mà `fetch` bị cấm đặt thì cài qua
`declarativeNetRequest` theo từng lượt tải rồi gỡ ngay khi xong.

## Đo tốc độ

Con số dưới đây **chỉ đúng khi server bóp tốc độ theo từng kết nối**. Nếu nghẽn nằm ở
đường truyền của bạn thì chia bao nhiêu luồng cũng như nhau — đó là giới hạn vật lý,
không phải chỗ để tối ưu.

**Phương pháp**, nói trước con số:

- Server test cục bộ `scripts/testserver.mjs` bóp tốc độ **riêng từng** kết nối.
- `bench/bench.ts` dùng **đúng** `planPieces`, `remainingRange`, `takeNextPending`,
  `ConcurrencyController` và `paceOptionsFor` của engine — lấy thẳng từ `src/`, không
  chép lại tham số, vì bản chép sẽ lệch đúng vào lúc engine đổi.
- Chỉ hai thứ bị thay: fetch worker thành vòng lặp trong Node, OPFS thành một `Buffer`.
- Chạy trên loopback: RTT gần bằng 0, không TLS, không mất gói, không DNS, không CDN
  thật. Đây là chặn trên lý tưởng, không phải kỳ vọng thực tế.
- Mỗi cấu hình chạy **sáu lần**, trên một máy phát triển. Tỉ lệ tăng tốc ra giống hệt
  nhau cả sáu lần; thời gian thô dao động khoảng 1% giữa các lần, và đó đúng bằng bề rộng
  của khoảng ghi trong bảng.
- Mọi lần đo đều kiểm từng byte theo `byte[i] = i % 251`; cả sáu lần đều báo đúng từng byte.

Kết quả sáu lần chạy `npm run bench` ngày 25-08-2026, trần 8 kết nối:

| | 4 MiB @ 500 KB/s mỗi kết nối | 32 MiB @ 2000 KB/s mỗi kết nối |
|---|---|---|
| 1 kết nối — cách trình duyệt tự tải | 8,22 – 8,26 s | 16,65 – 16,74 s |
| tăng tốc (bộ dò AIMD, bản đang chạy) | 2,03 – 2,04 s | 2,05 – 2,07 s |
| **nhanh gấp, so với một kết nối** | **4,0 lần** | **8,1 lần** |
| đỉnh kết nối engine thật sự dùng | **4** | 8 |

**Đã tái lập trên một máy thứ hai.** Job đo tốc độ trong CI chạy đúng phép đo này trên
runner của GitHub và ra 4,0 lần và 8,0 lần — ca 32 MiB thấp hơn bản chạy tại chỗ đúng
một phần mười, tức là đúng dáng của một máy dùng chung nhiều nhiễu. Tỉ lệ tái lập được
trên hai máy không liên quan gì tới nhau là điều mạnh nhất có thể nói về mấy con số này,
và nó vẫn chỉ là một phát biểu về một server test bị bóp băng thông, không phải về
internet thật.

**Ghi khoảng chứ không ghi một con số — cố ý.** Tỉ lệ thì ổn định tuyệt đối qua cả sáu
lần, thời gian thô thì không, nên trích một lần chạy tới hai chữ số thập phân — kiểu
`8.25s` — là tự nhận một độ chính xác mà phép đo này không có. Đó cũng đúng là cách bốn
tài liệu đi tới chỗ ghi bốn con số khác nhau cho cùng một phép đo. README.md,
ARCHITECTURE.md và CONTRIBUTING.md trích đúng bộ khoảng này, để bốn tài liệu không thể
lệch nhau.

**Vì sao file 4 MiB chỉ được 4,0 lần chứ không phải 8 lần.** `planPieces()` đặt piece tối
thiểu 1 MiB, nên một file 4 MiB chỉ ra đúng 4 piece — dù người dùng đặt trần 8 thì cũng
chỉ có 4 việc để phát. Mức tăng tốc bị chặn bởi **số piece**, mà số piece bị chặn bởi
**kích thước file**. File phải **vượt 7 MiB** thì piece thứ 8 mới tồn tại: gọi thẳng
`planPieces()` với `connections: 8`, ở đúng 7 MiB vẫn ra 7 piece, piece thứ 8 chỉ xuất
hiện từ **7.340.033 byte**, tức hơn đúng một byte. Dưới mức đó thì đặt trần bao nhiêu
cũng không chạm được 8 kết nối. File càng nhỏ, lợi càng ít; dưới 5 MiB thì extension trả
thẳng về cho trình duyệt (xem [Chế độ tự động](#chế-độ-tự-động)).

**Một con số cũ đã bị gỡ.** README trước đây ghi "8,4 lần cho file 4 MiB". Con số đó đo
bằng `curl` với 8 request song song thủ công, không phải hành vi của engine — mà engine
thì về mặt cấu trúc không thể đạt được nó, đúng vì trần 4 piece vừa nói ở trên. Đó là
nói quá. Nó đã bị xóa và sẽ không quay lại.

**Bộ đo đã bắt được một hồi quy thật, trong code của chính tác giả.** Bản đầu của bộ dò
AIMD khởi đầu ở 2 kết nối rồi leo dần, nhích một bậc mỗi hai cửa sổ đo (khoảng 4 giây),
nên đi từ 2 lên 8 mất chừng 24 giây — dài hơn hẳn phần lớn lượt tải, và suốt quãng đó nó
phớt lờ trần mà người dùng đã đặt. Đo được: file 4 MiB chậm đi 93%, file 32 MiB chậm đi
210%. Sửa thành mở thẳng ở trần, AIMD chỉ còn làm phanh khi server đẩy lại. Sau khi sửa,
nó ngang bằng trần cứng (chênh 0–5%, nằm trong sai số giữa các lần chạy). Bốn test trong
`test/integration.test.ts` khóa `paceOptionsFor()` lại.

*Lưu ý: nhánh code cũ đã bị xóa, nên hai con số 93% và 210% được đo trước khi sửa và
không dựng lại được từ cây mã hiện tại. `npm run bench` hôm nay chỉ in hai hàng
"trần cứng" và "AIMD".*

**Bộ đo này chứng minh cái gì, và không chứng minh cái gì.** Nó chứng minh thuật toán
chia piece, hàng chờ work-stealing và bộ dò số kết nối. Nó **không** chạm tới: writer
worker, `MessagePort` transfer, biên nhận ghi, OPFS, retry, nguồn dự phòng, HLS,
`DownloadJob`, và — đáng nói nhất — **không** dùng `throttle.ts`, tức xô token chung cho
cả extension chưa từng được đo lần nào (nó chỉ có test đơn vị).

## Cài và chạy

Cần Node 20 trở lên (esbuild nhắm `node20`, bộ test dùng `node:test` và `fetch` toàn cục).

```bash
npm install
npm run build              # ra dist/chromium và dist/firefox (__DEV__=false, log bị cắt sạch)
npm run build:dev          # cùng hai target, nhưng giữ log [df:…] và sourcemap inline
npm run build:chromium     # hoặc chỉ một target
npm run build:firefox
npm run watch              # build lại khi sửa file; ngầm bật --dev
npm test                   # 397 test
npm run typecheck          # tsconfig.json và tsconfig.worker.json
npm run testserver         # http://localhost:8787
npm run bench              # cần testserver chạy trước ở cửa sổ khác
npm run verify <file>      # kiểm file tải về theo byte[i] = i % 251
npm run make-icons
npm run clean
```

Nạp vào trình duyệt:

- **Chromium**: `chrome://extensions` → bật Developer mode → *Load unpacked* → chọn
  `dist/chromium`
- **Firefox**: `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on* → chọn
  `dist/firefox/manifest.json`

Chỗ xem log khi thử:

- **Chromium**: `chrome://extensions` → *Details* → *Inspect views* → chọn
  `offscreen.html`. Engine chạy ở đó, không phải trong service worker.
- **Firefox**: `about:debugging#/runtime/this-firefox` → *Inspect*

**Muốn thấy log thì phải dựng bằng `npm run build:dev`.** `npm run build` đặt
`__DEV__=false`, và esbuild cắt bỏ luôn mọi lời gọi `console.log` ngay lúc build — nên
một console gần như trống là kết quả **bình thường** của bản mặc định, không phải bằng
chứng extension không chạy. Bản mặc định chỉ còn đúng **một** `console.warn` mỗi bundle
(nhánh dự phòng của i18n); `fetch-worker.js`, `writer-worker.js` và `media-detect.js`
không còn dòng console nào. Và **đừng đi tìm `console.error`**: `error()` có export ở
`src/shared/log.ts:15` nhưng không nơi nào trong `src/` gọi nó, nên không bundle nào phát
ra một dòng đỏ nào cả. `npm run build:dev` (và `npm run watch`, vốn ngầm `--dev`) giữ lại
các dòng `[df:…]` kèm sourcemap inline.

## Chế độ tự động

**Cảnh báo trước, vì mục này nói về những lời hứa an toàn.** Chế độ tự động nằm trọn
trong lớp chưa có test. `policy.ts` (65 dòng, 16 test) chỉ *ra quyết định*; phần *thi
hành* việc trả file về cho trình duyệt nằm ở `background/index.ts` (469 dòng, 0 test) và
`DownloadJob` (815 dòng, 0 test) — cả hai đều chưa có test và chưa từng chạy trong một
trình duyệt nào. Ba nguyên tắc dưới đây là ý định thiết kế, chưa phải bảo đảm đã kiểm
chứng.

Mặc định extension tự nhận mọi lượt tải, người dùng không phải làm gì. Ba nguyên tắc chi
phối thiết kế này, và chúng quan trọng hơn phần giao diện:

**Không bao giờ để mất file.** Giành lượt tải của trình duyệt là nhận trách nhiệm giao
lại file đó. Engine hỏng vì bất kỳ lý do gì — server cần header đặc biệt, link đến từ
POST, phiên đăng nhập hết hạn — thì URL gốc được lặng lẽ trả về cho trình duyệt tải kiểu
thường. Người rành công nghệ có thể tự copy link tải lại, người không rành thì không;
nên đường lui phải tự động.

**Chỉ giành việc mình làm tốt hơn.** Server không hỗ trợ `Range`, hoặc file nhỏ hơn
5 MiB, thì trả ngay về cho trình duyệt thay vì cố. Thêm một mắt xích chỉ để nhanh hơn vài
phần trăm là lỗ vốn. Một chỗ dễ hiểu nhầm, nói cho rõ: cổng lọc chỉ **từ chối lượt tải đã
biết chắc là nhỏ** — `item.fileSize > 0 && item.fileSize < ctx.minSize`
(`src/engine/policy.ts:62`) — nên lượt tải mà trình duyệt **chưa cho biết kích thước**
(`fileSize` bằng `-1`) vẫn bị nhận, rồi engine tự đo lấy.

**Không im lặng quá lâu.** Trong lúc engine chạy, thanh download quen thuộc của trình
duyệt không hiện gì — với file lớn đó là vài phút đủ để người dùng tưởng máy hỏng. Biểu
tượng extension hiện số lượt đang tải, và lần đầu tiên có một thông báo giải thích
chuyện gì đang xảy ra.

Những quyết định này nằm gọn trong `src/engine/policy.ts` — 65 dòng, 16 test. Tách riêng
vì chúng dễ sai nhất: đoán sai một nước là người dùng mất file, hoặc extension rơi vào
vòng lặp tự giành lại chính lượt tải nó vừa buông ra (có test khóa đúng ca đó).

## Kiểm thử

### Test tự động

```bash
npm test         # 397 test, chạy trong khoảng một giây
npm run typecheck
```

397 test, 0 fail, 0 skip, 0 todo. Phân rã theo file:

| File | Số test | Phủ cái gì |
|---|---|---|
| `test/hls.test.ts` | 90 | parser playlist, chọn variant, `BYTERANGE`, `EXT-X-KEY/MAP/GAP`, live vs VOD, AES-128 + IV + PKCS#7, `KeyStore`, chặn DRM, `OrderedSink`, `validateForConcat` |
| `test/adaptive.test.ts` | 82 | AIMD tăng/giảm, 429/503, `Retry-After`, phân loại header, phát lại Referer theo bậc, `RuleIdAllocator`, `HeaderStore`, so vân tay nguồn, nối lại bằng `Range`, 416 |
| `test/control.test.ts` | 59 | xô token, hai worker chia luân phiên, đổi tốc độ giữa chừng, trần đồng thời, ưu tiên, `moveToFront`, khung giờ vắt qua nửa đêm |
| `test/persistence.test.ts` | 59 | chốt sổ tiến độ, khôi phục sau khởi động lại |
| `test/i18n.test.ts` | 49 | i18n và thông báo cho trình đọc màn hình |
| `test/engine.test.ts` | 22 | chia piece, đặt tên file (RFC 5987, tên Windows, không thoát thư mục), thăm dò server |
| `test/policy.test.ts` | 16 | chế độ tự động |
| `test/integration.test.ts` | 20 | cài đặt tới engine, phân loại lỗi, `paceOptionsFor`, chốt chặn `requireStorage()` |

Vài chỗ đáng nói vì chúng khóa lại đúng loại lỗi khó thấy:

- Test AES-128 dùng WebCrypto **thật** của Node (`crypto.subtle.encrypt` dựng dữ liệu
  rồi bắt engine giải), không phải mock.
- Bất biến 188 byte của MPEG-TS bắt được ca file bị cắt đuôi vì padding giả.
- ETag **yếu** khớp nhau chỉ được coi là "có khả năng cùng file", không đủ để chia piece.
- `planReplay` không bao giờ gửi bí mật sang origin khác.
- Không đọc được thư mục `parts` thì giữ nguyên mọi thứ, tuyệt đối không dọn.

Cảnh báo về tên file: `integration.test.ts` **không** phải test tích hợp. Mười sáu trong
số 20 test bên trong là khẳng định về hàm thuần; bốn test còn lại lái `requireStorage()`
bằng một bộ dò tiêm vào. Không có gì được ghép với trình duyệt, với worker hay với file
thật. Cái tên là sai, đừng dựa vào nó để suy ra dự án có test tích hợp.

### Test phủ tới đâu

Đây là phần khó chịu, và nó nằm đây thay vì bị giấu ở cuối trang.

**15 trong 40 file của `src/` — 3.154 dòng — không một test nào chạm tới, kể cả gián
tiếp**: `engine/manager.ts` (614), `ui/manager.ts` (544), `background/index.ts` (469),
`content/media-detect.ts` (270), `engine/workers/fetch-worker.ts` (264), `ui/dom.ts`
(227), `ui/popup.ts` (223), `shared/rpc.ts` (142), `engine/workers/writer-worker.ts` (82),
`offscreen/offscreen.ts` (80), `platform/capabilities.ts` (78), `shared/protocol.ts` (69),
`ui/format.ts` (38), `engine/host.ts` (33), `ui/welcome.ts` (21). Đúng là lớp keo:
HostBridge, offscreen, hai worker, content script, và cả giao diện.

Phạm vi ở đây lấy từ metafile của esbuild cho bundle test, nên một file được tính là "có
chạm tới" kể cả khi không test nào import nó theo tên. Bản trước của mục này ghi *18 file,
3.288 dòng, không có một import test nào* — đó là phép đếm import **trực tiếp**, nhưng câu
chữ lại đọc ra thành "không test nào chạy đoạn code này", mà điều đó không đúng với
`engine/storage.ts` (88), `platform/api.ts` (67) và `shared/log.ts` (17): cả ba đều được
kéo vào gián tiếp và có thật sự chạy trong `npm test`. "Không được test riêng" và "không
bao giờ chạy" là hai khẳng định khác nhau; danh sách trên là khẳng định thứ hai.

`platform/capabilities.ts` là ca ngoại lệ một phần, và cần nói cho chính xác: bốn test
trong `test/integration.test.ts` nay đã phủ `requireStorage()` — chốt chặn mà
`DownloadJob.openWriter()` gọi trước khi dựng writer. Còn `detectCapabilities()`, nửa thật
sự đi hỏi `navigator.storage`, thì chưa test nào chạy tới, và cũng chưa thể chạy tới chừng
nào chưa có ai mở nó trong một trình duyệt.

**Hai lớp lớn nhất dự án nằm trong file "có test" nhưng bản thân chúng không được test:**

- `DownloadJob` — `src/engine/orchestrator.ts` dòng 153–967, tức 815 dòng. File này
  có xuất hiện trong test, nhưng test chỉ import hai hàm thuần từ nó: `failureKind` và
  `paceOptionsFor`.
- `HlsJob` — `src/engine/hls/index.ts` dòng 518–1091, khoảng 574 dòng. `hls.test.ts` chỉ
  import `classifyMediaUrl` và `buildSegmentRequests` từ file 1.188 dòng đó.

Cộng lại **4.543 dòng, tức khoảng 34% của 13.393 dòng trong `src/`**. Nói cho đúng: các
**mảnh** đã được test kỹ, còn thứ **nối chúng lại** thành một lượt tải thì chưa từng
được test lẫn chưa từng chạy.

Và điều đáng nói nhất: `DownloadJob` với `HlsJob` là code thuần logic, hoàn toàn test
được bằng cách bơm cổng giả — đúng kiểu `persistence.test.ts` đang làm. Chúng không có
test **không phải** vì phụ thuộc trình duyệt. Đó là nợ, không phải giới hạn.

Thêm hai điều về phạm vi:

- Cả hai `tsconfig` chỉ `include` `src/**`, nên **5.467 dòng trong `test/` cộng 163 dòng
  `bench/bench.ts` — tổng 5.630 dòng — chưa bao giờ được typecheck** — `esbuild` chỉ xóa kiểu chứ không kiểm
  kiểu. Phần `src/` thì bật `strict` và `noUncheckedIndexedAccess`.
- Luật `declarativeNetRequest` được **dựng** đúng theo test đơn vị (`buildRuleSpec`,
  `RuleIdAllocator`), nhưng việc **cài** luật vào trình duyệt
  (`declarativeNetRequest.updateSessionRules`) thì chưa từng chạy. Điều này đúng với cả
  `notifications.create`, `action.setBadgeText`, `contextMenus.create`, `tabs.create`.

### Server test cục bộ

```bash
npm run testserver          # http://localhost:8787
```

Server sinh dữ liệu theo công thức `byte[i] = i % 251` thay vì đọc từ đĩa. Nhờ vậy file
tải về kiểm tra được từng byte — chỉ cần một piece ghi lệch offset là lộ ra:

```bash
npm run verify ~/Downloads/ten-file.bin
```

| Endpoint | Dùng để thử |
|---|---|
| `/file/<bytes>` | Đường bình thường, hỗ trợ `Range` đầy đủ |
| `/slow/<bytes>?kbps=200` | Bóp tốc độ **từng** kết nối — chỗ duy nhất thấy rõ tăng tốc |
| `/norange/<bytes>` | Server phớt lờ `Range`, engine phải lui về một luồng |
| `/gzip/<bytes>` | Nén trên đường truyền, phải tự tắt chia luồng |
| `/named/<bytes>` | `Content-Disposition` tên tiếng Việt theo RFC 5987 |
| `/flaky/<bytes>?drop=1048576` | Đứt kết nối giữa chừng, thử đường retry |
| `/stats` | `{active, peak, totalRequests}` — **đếm kết nối, không đo byte** |

### Danh sách kiểm thử thủ công

Đây là thứ để lấp đúng khoảng trống "chưa từng chạy trong browser". Chưa mục nào được
làm. Nạp `dist/chromium` hoặc `dist/firefox`, chạy server test, rồi dán liên kết vào
trang quản lý.

Đường tải cơ bản:

1. `/slow/104857600?kbps=200` — trang quản lý phải hiện 8 kết nối, `/stats` xác nhận
2. `/norange/10485760` — phải tụt về 1 kết nối mà vẫn tải xong
3. `/gzip/10485760` — phải tắt chia luồng, không được ghi hỏng file (phải trên 2 MiB,
   vì dưới ngưỡng đó `planPieces` vốn đã trả về một piece nên mục này không chứng
   minh được gì)
4. `/named/1048576` — tên file lưu ra phải là `báo cáo thử.bin`
5. `/flaky/10485760?drop=1048576` — phải tự thử lại và vẫn ra file đúng
6. Tạm dừng giữa chừng rồi tiếp tục — `verify` vẫn phải báo đúng toàn bộ
7. Hủy giữa chừng — kiểm tra file tạm đã bị dọn khỏi OPFS
8. Mọi file tải xong đều đem qua `npm run verify`

Chế độ tự động:

9. Tải một file **nhỏ** (`/file/1048576`) — extension phải để yên cho trình duyệt
10. `/norange/104857600` — phải trả lại cho trình duyệt, không tự tải một luồng
11. Tắt server giữa chừng — file phải được trình duyệt tải lại, không báo lỗi cụt
12. Sau mỗi lần trả việc, kiểm tra không có vòng lặp tải đi tải lại

Các tính năng còn lại:

13. **Hàng đợi** — đặt "2 file cùng lúc", thả 5 link vào, đúng 2 chạy; đổi ưu tiên và
    bấm *Lên đầu hàng* phải đổi đúng thứ tự sắp chạy
14. **Giới hạn tốc độ** — đặt 500 KB/s rồi tải một file lớn, bấm giờ để kiểm tổng tốc độ
    là 500 KB/s cho **toàn bộ** extension chứ không phải cho mỗi kết nối. Lưu ý `/stats`
    **không** giúp được ở đây: nó chỉ trả `{active, peak, totalRequests}`, không có byte
    và không có tốc độ. Muốn xác minh tự động thì phải thêm bộ đếm byte vào testserver.
15. **Khung giờ** — đặt một khung sắp đóng, lượt tải phải tự dừng và tự chạy lại khi tới
    giờ (Chromium hạ tần số alarm khi rảnh, chờ thêm vài phút là bình thường)
16. **Khôi phục** — tải file lớn, tắt hẳn trình duyệt giữa chừng, mở lại: lượt tải phải
    tiếp tục từ gần chỗ cũ, và `npm run verify` vẫn phải báo đúng toàn bộ
17. **Không rõ kích thước** — *chưa thử được bằng công cụ hiện có.* Đường streaming
    (`src/engine/adaptive/streaming.ts`, 691 dòng) có 18 test đơn vị trong
    `adaptive.test.ts`, nhưng `scripts/testserver.mjs` không có endpoint chunked nào:
    mọi nhánh đều đặt `content-length`, kể cả `/norange`. Phải thêm endpoint trước đã.
18. **Nhiều nguồn** — dán hai link cùng một file (mỗi dòng một cái); thử cả trường hợp
    link thứ hai là file **khác**, engine phải loại nó và ghi lý do vào log
19. **Video** — mở một trang có HLS, popup phải hiện mục video; file ghép ra phải mở được
    bằng trình phát
20. **Bàn phím và trình đọc màn hình** — đi hết danh sách bằng phím mũi tên, mọi nút đều
    tới được bằng Tab, tiến độ được đọc theo mốc chứ không đọc liên tục
21. **Đổi ngôn ngữ** — đặt trình duyệt sang tiếng Anh, giao diện phải theo

## Không có telemetry

Không phải hứa, mà kiểm được bằng một dòng:

```bash
grep -rnE '\bfetch\(|fetchImpl\(' src/ --include=*.ts
```

Ra **13** dòng. Hai dòng không phải request: một chú thích ở
`engine/adaptive/headers.ts:264` có chứa chữ `fetch()`, và định nghĩa hàm bao ở
`engine/adaptive/streaming.ts:151`. Còn lại **11** chỗ thật sự phát request. **10** chỗ
trỏ tới URL do chính bạn đưa vào:

- `engine/probe.ts:58` và `:92` — request thăm dò để biết kích thước file, và đường lui
  bằng `HEAD`
- `engine/workers/fetch-worker.ts:97` — các request `Range`, tức chính lượt tải
- `engine/orchestrator.ts:365` — đọc một khoảng byte của nguồn dự phòng để so xem có đúng
  cùng một file không
- `engine/adaptive/streaming.ts:445`, `:626`, `:674` — đường một luồng cho server giấu
  kích thước, cùng bước dò kích thước và bước kiểm khi nối lại
- `engine/hls/index.ts:152` và `:830` — playlist và segment
- `engine/hls/keys.ts:207` — URI khóa AES-128 do chính playlist khai

Chỗ thứ 11 là `shared/i18n.ts:303`, nạp
`runtime.getURL('_locales/<locale>/messages.json')` — tài nguyên nội bộ của extension,
không bao giờ ra ngoài.

Nửa `fetchImpl(` của lệnh grep là phần quan trọng: `streaming.ts` nhận `fetch` như một
tham số tiêm để test thay được, nên grep trơn `fetch(` sẽ bỏ sót đúng ba chỗ gọi mạng
thật. Bản trước của tài liệu này đếm ra 9 vì đúng lỗi đó — kết luận thì vẫn đúng, phép
đếm thì sai. Không có `XMLHttpRequest`, không `WebSocket`, không `sendBeacon`, không
`new Image()`, không endpoint thu thập nào. PRIVACY.md còn chạy phép kiểm mạnh hơn: grep
URL trong **bundle đã build**, và số URL từ xa nhét cứng trong mã là 0.

### Extension xin những quyền gì

Không có telemetry không có nghĩa là ít xâm phạm. Đây là những gì manifest xin
(`manifest/base.json`):

| Xin gì | Để làm gì |
|---|---|
| `host_permissions: <all_urls>` | Request `Range` phải gửi được tới bất kỳ máy chủ nào bạn đang tải file, nên phải mở cho mọi host |
| content script trên `<all_urls>`, `all_frames: true` | Dò thẻ `<video>` và URL `.m3u8` — nghĩa là nó đọc được nội dung mọi trang bạn mở, ở mọi khung |
| `downloads` | Giao file đã tải xong cho trình duyệt, và giành lượt tải khi bật chế độ tự động |
| `storage`, `unlimitedStorage` | Cài đặt, chốt sổ tiến độ, file tạm trong OPFS |
| `notifications`, `contextMenus`, `alarms` | Thông báo khi xong, mục chuột phải, khung giờ tải |
| `declarativeNetRequestWithHostAccess` | Đặt `Referer`, `Origin`, `User-Agent`, `Cookie` cho request của **chính extension** — những header mà `fetch()` bị cấm đặt |

Nói thẳng: extension này đọc được nội dung mọi trang bạn mở, và khi một link đòi, nó có
phát lại `Cookie` của bạn tới máy chủ đang tải file. Việc phát lại đó là bậc cuối (bậc 3
của `planReplay()`) và chỉ cùng origin — cookie thu được sẽ bị bỏ chứ không gửi sang
origin khác (`src/engine/adaptive/headers.ts:314-323`, có test khóa lại). Giá trị chỉ nằm
trong RAM, có TTL, không có đường nào ghi xuống `chrome.storage` (`HeaderStore` trong
cùng file). Nhưng chuỗi cookie là bí mật đăng nhập, và đoạn mã này có chạm vào nó.
PRIVACY.md đi qua từng quyền một.

## Quốc tế hóa

141 khóa, hai ngôn ngữ: tiếng Việt và tiếng Anh, đủ cả 141 ở mỗi bên. Cả 141 khóa tiếng
Việt đều có `description` cho người dịch, và có test bắt buộc điều đó — thiếu một cái là
đỏ. Giao diện tự theo ngôn ngữ trình duyệt.

## Trạng thái

Đã viết xong (nhắc lại: chưa chạy trong browser thật):

- Chế độ tự động: tự nhận lượt tải, tự trả lại khi không tăng tốc được hoặc khi hỏng
- Thăm dò server bằng một request, tự nhận biết server có hỗ trợ `Range` không
- Tải song song, tự lui về một luồng khi server không cho chia
- Tự dò số kết nối (AIMD), tự lùi khi server trả 429/503 và tôn trọng `Retry-After`
- Thử lại theo từng piece, phân biệt lỗi tạm thời và lỗi vĩnh viễn
- Tải được cả khi server giấu kích thước: một luồng, tự nối lại chỗ đứt
- Nhiều nguồn cho cùng một file, kèm bước xác minh hai bản đúng là một
- Phát lại Referer theo bậc qua `declarativeNetRequest`
- Hàng đợi: trần số file cùng lúc, mức ưu tiên, kéo lên đầu hàng
- Giới hạn tốc độ chung cho cả extension bằng xô token
- Khung giờ tải, tự dừng và tự chạy lại theo `chrome.alarms`
- Chốt sổ tiến độ xuống `storage.local` và khôi phục lượt tải dở sau khi khởi động lại
- Tải HLS: đọc playlist, chọn chất lượng, giải mã AES-128, ghép segment
- Dò video trong trang bằng content script, popup hiện nút tải
- Tiếng Việt và tiếng Anh, điều hướng bàn phím, thông báo cho trình đọc màn hình
- Màn hình chào, công tắc bật/tắt, badge, thông báo khi xong
- Trang quản lý hai tab: danh sách lượt tải và bảng cài đặt đầy đủ

Chưa xong, hoặc chưa chứng minh được:

- **Chưa chạy thử trong trình duyệt thật**, và khoảng 34% mã nguồn chưa có test. Hai mục ở trên
  đã nói kỹ.
- HLS chỉ ghép segment, **chưa remux** — luồng video và audio tách rời chưa gộp được
  thành một file. Nói cho chính xác về HLS: parser playlist, chọn variant, giải mã
  AES-128 đều có test dày (90 test); vế "ghép thành một file" thì chưa có một lượt tải
  HLS nào từng chạy trọn. CSP đã mở sẵn `wasm-unsafe-eval` cho `ffmpeg.wasm` khi làm tới.
- DASH mới chỉ nhận diện được URL, chưa tải được.
- Service worker của Chromium nạp cả bundle khoảng 118 KB (118.084 byte), phần lớn là engine mà nhánh Chromium
  không dùng, vì `installEngineHost` được import tĩnh cho nhánh Firefox. Phí, không sai.
- Trên Firefox MV3, `host_permissions` là quyền tùy chọn nên người dùng phải tự cấp;
  extension chưa có màn hình xin quyền.
- Trên Firefox, `runtime.sendMessage` không gửi được cho chính ngữ cảnh gửi. Đã xử lý
  bằng cách gọi thẳng `dispatchEngineRequest()` (`src/background/index.ts:212`), nhưng
  chưa xác minh trên Firefox thật.

## Giới hạn có thật

**Nhiều kết nối chỉ nhanh hơn khi server bóp tốc độ theo từng kết nối.** Nếu nghẽn nằm ở
đường truyền của bạn thì chia bao nhiêu luồng cũng như nhau. Đây là vật lý, không phải
chỗ có thể tối ưu thêm. Và như bảng đo cho thấy, mức tăng tốc còn bị chặn bởi số piece,
mà số piece bị chặn bởi kích thước file.

**Không có BitTorrent, và sẽ không bao giờ có.** Trình duyệt không cho mở TCP socket.
WASM cũng không cứu được: WebTorrent chỉ nói chuyện được với peer WebRTC nên gần như
không tìm ra seeder.

**Nhưng BitTorrent không phải ranh giới duy nhất, và so sánh cho công bằng thì khoảng
cách rộng hơn một tính năng.** aria2 và Motrix là chương trình gốc: chúng còn làm FTP và
SFTP, Metalink, magnet và DHT, chạy headless trên server, điều khiển qua RPC và CLI, và
tải tiếp cả khi trình duyệt đã đóng — chúng cũng không bị trần kết nối của trình duyệt
hay ràng buộc MV3, tức gần hết những thứ mà code base này bỏ ra 13.393 dòng để đi vòng
qua. Và chúng đã chạy thật trên máy thật hàng chục năm; cái này thì chưa chạy trong một
trình duyệt nào lần nào.

Thứ một extension có mà chúng không có là **phiên đăng nhập của bạn**: nó đang giữ sẵn
cookie và phiên của bạn nên tải được file sau login mà công cụ ngoài trình duyệt không
thấy. Toàn bộ nội dung của sự đánh đổi nằm ở đó.

**File tồn tại hai bản trên đĩa trong chốc lát:** bản tạm trong OPFS và bản đích sau khi
bàn giao. Code có gọi `navigator.storage.estimate()` để xem dung lượng trống trước khi
bắt đầu (`src/engine/storage.ts`), nhưng `storage.ts` không có test và lời gọi đó nằm
trong `DownloadJob`/`HlsJob` vốn cũng không có test — nên đừng coi đây là một bảo đảm.

**Blob URL trên file lớn.** Bước bàn giao gọi `storage.partAsBlobUrl()` rồi đưa kết quả
cho `chrome.downloads`. Nó dựa vào giả định rằng tạo blob URL từ một `File` của OPFS
không kéo toàn bộ nội dung vào bộ nhớ. Đó là giả định về hành vi trình duyệt, chưa hề
được kiểm chứng — và trường hợp nó gây hại, file vài GB, đúng là trường hợp mà extension
này sinh ra để phục vụ.

## Đóng góp

Thứ hữu ích nhất lúc này là **chạy thử trong một trình duyệt thật** và báo lại mục nào
trong 21 mục ở trên gãy. Sau đó là test cho `DownloadJob` và `HlsJob` — hai lớp đó thuần
logic, bơm cổng giả vào là test được, và chúng đang là khoảng trống lớn nhất.

## Số liệu dự án

| | |
|---|---|
| TypeScript trong `src/` | 13.393 dòng, 40 file |
| Test | 5.467 dòng, 8 file, 397 ca, chạy bằng `node:test`, không phụ thuộc framework nào |
| Phụ thuộc lúc chạy | không có |
| Phụ thuộc lúc build | esbuild, typescript, `@types/chrome` |
| Bản địa hóa | 141 khóa, tiếng Việt và tiếng Anh; mỗi khóa tiếng Việt đều có description cho người dịch, có test bắt buộc |
| Trình duyệt tối thiểu | Chrome 116, Firefox 128 — khai trong manifest theo tài liệu API, chưa xác minh trên máy thật |

## Tài liệu

- [ARCHITECTURE.md](ARCHITECTURE.md) — vì sao engine không nằm trong service worker, và
  những ràng buộc đã định hình mọi thứ còn lại
- [CONTRIBUTING.md](CONTRIBUTING.md) — cách build, cách test, và chỗ đang cần giúp nhất
- [SECURITY.md](SECURITY.md) — báo cáo lỗ hổng
- [PRIVACY.md](PRIVACY.md) — extension thu thập gì và không thu thập gì
- [README.md](README.md) — English version

## Giấy phép

MIT. Xem [LICENSE](LICENSE).
