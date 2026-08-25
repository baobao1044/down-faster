import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  containerExtension,
  detectContainer,
  parseAttributes,
  parseByteRange,
  parseHexIv,
  parseMedia,
  parsePlaylist,
  pickAudioRendition,
  pickVariant,
  PlaylistError,
  type KeyInfo,
  type MasterPlaylist,
  type MediaPlaylist,
  type Segment,
} from '../src/engine/hls/playlist';
import {
  AES_BLOCK,
  assertSupported,
  decryptSegment,
  decryptWithoutPadding,
  ivForSegment,
  ivFromSequence,
  keyFromDataUri,
  KeyStore,
  UnsupportedEncryptionError,
} from '../src/engine/hls/keys';
import {
  OrderedSink,
  planAssembly,
  validateForConcat,
  type ChunkSink,
} from '../src/engine/hls/assemble';
import { buildSegmentRequests, classifyMediaUrl } from '../src/engine/hls/index';

const BASE = 'https://cdn.test/video/hd/index.m3u8';

/** Ép kiểu vì mọi playlist mẫu ở dưới đều là media playlist; sai thì test tự đỏ. */
function media(text: string, base = BASE): MediaPlaylist {
  const parsed = parsePlaylist(text, base);
  assert.equal(parsed.kind, 'media');
  return parsed as MediaPlaylist;
}

function master(text: string, base = BASE): MasterPlaylist {
  const parsed = parsePlaylist(text, base);
  assert.equal(parsed.kind, 'master');
  return parsed as MasterPlaylist;
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

/**
 * `crypto.subtle` khai tham số là `BufferSource`, tức `ArrayBufferView<ArrayBuffer>`,
 * còn `Uint8Array` mặc định lại đứng trên `ArrayBufferLike`. Ép kiểu ở đúng một chỗ
 * thay vì rải `as BufferSource` khắp file — cùng cách mà keys.ts đang làm.
 */
function src(bytes: Uint8Array): BufferSource {
  return bytes as unknown as BufferSource;
}

/* ---------- Tách attribute list ---------- */

test('giá trị trong dấu nháy giữ được dấu phẩy — tách sai chỗ này làm hỏng cả danh sách variant', () => {
  const attrs = parseAttributes('BANDWIDTH=1280000,CODECS="avc1.4d401f,mp4a.40.2",RESOLUTION=640x360');
  assert.equal(attrs.get('CODECS'), 'avc1.4d401f,mp4a.40.2');
  assert.equal(attrs.get('BANDWIDTH'), '1280000');
  assert.equal(attrs.get('RESOLUTION'), '640x360');
});

test('giá trị trần, số hex và khoảng trắng thừa quanh dấu bằng đều đọc được', () => {
  const attrs = parseAttributes('METHOD=AES-128, IV = 0xABCDEF , DEFAULT=YES');
  assert.equal(attrs.get('METHOD'), 'AES-128');
  assert.equal(attrs.get('IV'), '0xABCDEF');
  assert.equal(attrs.get('DEFAULT'), 'YES');
});

test('tên thuộc tính không phân biệt hoa thường', () => {
  const attrs = parseAttributes('bandwidth=100,Resolution=1x1');
  assert.equal(attrs.get('BANDWIDTH'), '100');
  assert.equal(attrs.get('RESOLUTION'), '1x1');
});

test('thuộc tính cụt không kéo theo cả dòng — BANDWIDTH cùng dòng vẫn phải sống', () => {
  const attrs = parseAttributes('JUNK,BANDWIDTH=999,ALSOJUNK');
  assert.equal(attrs.get('BANDWIDTH'), '999');
  assert.equal(attrs.has('JUNK'), false);
});

test('rác nằm giữa dấu nháy đóng và dấu phẩy không nuốt mất thuộc tính kế tiếp', () => {
  const attrs = parseAttributes('URI="key.bin" ,METHOD=AES-128');
  assert.equal(attrs.get('URI'), 'key.bin');
  assert.equal(attrs.get('METHOD'), 'AES-128');
});

/* ---------- Master playlist ---------- */

const MASTER = `#EXTM3U
#EXT-X-VERSION:4
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="Tiếng Việt",LANGUAGE="vi",DEFAULT=YES,AUTOSELECT=YES,URI="audio/vi.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="English",LANGUAGE="en",DEFAULT=NO,URI="audio/en.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Việt",LANGUAGE="vi",URI="subs/vi.m3u8"
#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=99999999,RESOLUTION=1920x1080,URI="iframe/high.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=800000,AVERAGE-BANDWIDTH=700000,RESOLUTION=640x360,CODECS="avc1.42c01e,mp4a.40.2",FRAME-RATE=25
low/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,CODECS="avc1.4d401f,mp4a.40.2",FRAME-RATE=29.97,AUDIO="aac",SUBTITLES="subs"
mid/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=6200000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="aac"
high/index.m3u8
`;

test('BANDWIDTH, RESOLUTION, CODECS và FRAME-RATE của variant đọc đúng', () => {
  const m = master(MASTER);
  assert.equal(m.variants.length, 3);

  const mid = m.variants[1]!;
  assert.equal(mid.bandwidth, 2_500_000);
  assert.deepEqual(mid.resolution, { width: 1280, height: 720 });
  assert.deepEqual(mid.codecs, ['avc1.4d401f', 'mp4a.40.2']);
  assert.equal(mid.frameRate, 29.97);
  assert.equal(mid.audioGroup, 'aac');
  assert.equal(mid.subtitleGroup, 'subs');

  const low = m.variants[0]!;
  assert.equal(low.averageBandwidth, 700_000);
  assert.equal(low.audioGroup, null);
});

test('URI tương đối resolve theo baseUrl có đường dẫn con', () => {
  const m = master(MASTER);
  assert.equal(m.variants[0]!.uri, 'https://cdn.test/video/hd/low/index.m3u8');
});

test('EXT-X-I-FRAME-STREAM-INF bị bỏ qua — tải vào chỉ ra một video giật cục', () => {
  const m = master(MASTER);
  assert.equal(m.variants.some((v) => v.uri.includes('iframe')), false);
  // Băng thông khai của luồng I-frame rất lớn; nếu lọt vào thì 'best' sẽ chọn nhầm nó.
  assert.equal(pickVariant(m, 'best')!.bandwidth, 6_200_000);
});

test('EXT-X-MEDIA TYPE=AUDIO gom thành rendition và biết đâu là DEFAULT', () => {
  const m = master(MASTER);
  const audio = m.renditions.filter((r) => r.type === 'AUDIO');
  assert.equal(audio.length, 2);
  assert.equal(audio[0]!.name, 'Tiếng Việt');
  assert.equal(audio[0]!.language, 'vi');
  assert.equal(audio[0]!.isDefault, true);
  assert.equal(audio[0]!.uri, 'https://cdn.test/video/hd/audio/vi.m3u8');
  assert.equal(audio[1]!.isDefault, false);
});

test("pickVariant 'best' lấy băng thông cao nhất, 'worst' lấy thấp nhất", () => {
  const m = master(MASTER);
  assert.equal(pickVariant(m, 'best')!.resolution!.height, 1080);
  assert.equal(pickVariant(m, 'worst')!.resolution!.height, 360);
});

test('pickVariant với trần chiều cao lấy bản cao nhất còn vừa trần', () => {
  const m = master(MASTER);
  assert.equal(pickVariant(m, { maxHeight: 720 })!.resolution!.height, 720);
});

test('không variant nào vừa trần thì lấy bản nhỏ nhất, chứ không hủy lượt tải', () => {
  const m = master(MASTER);
  assert.equal(pickVariant(m, { maxHeight: 144 })!.resolution!.height, 360);
});

test('pickAudioRendition chọn bản DEFAULT trong nhóm AUDIO của variant', () => {
  const m = master(MASTER);
  const chosen = pickAudioRendition(m, m.variants[2]!);
  assert.equal(chosen!.language, 'vi');
});

test('variant đã có tiếng ghép sẵn thì pickAudioRendition trả null', () => {
  const m = master(MASTER);
  // Variant 360p không khai thuộc tính AUDIO nên tiếng nằm ngay trong luồng của nó.
  assert.equal(pickAudioRendition(m, m.variants[0]!), null);
});

test('nhóm AUDIO mà mọi rendition đều không có URI cũng là tiếng ghép sẵn', () => {
  const m = master(`#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a1",NAME="Main",DEFAULT=YES
#EXT-X-STREAM-INF:BANDWIDTH=100000,AUDIO="a1"
v/index.m3u8
`);
  assert.equal(pickAudioRendition(m, m.variants[0]!), null);
});

/* ---------- Media playlist ---------- */

const VOD = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:VOD
#EXTINF:9.009,
seg0.ts
#EXTINF:10,Đoạn hai
seg1.ts
#EXTINF:3.003,
../shared/seg2.ts
#EXT-X-ENDLIST
`;

test('EXTINF đọc được cả số nguyên lẫn số thập phân và cộng ra tổng thời lượng', () => {
  const m = media(VOD);
  assert.equal(m.segments.length, 3);
  assert.equal(m.segments[0]!.duration, 9.009);
  assert.equal(m.segments[1]!.duration, 10);
  assert.equal(Math.round(m.totalDuration * 1000), 22012);
});

test('phần sau dấu phẩy của EXTINF là tiêu đề, không phải một phần thời lượng', () => {
  const m = media(VOD);
  assert.equal(m.segments[1]!.title, 'Đoạn hai');
  assert.equal(m.segments[0]!.title, null);
});

test('URI segment resolve được cả đường dẫn lùi thư mục', () => {
  const m = media(VOD);
  assert.equal(m.segments[0]!.uri, 'https://cdn.test/video/hd/seg0.ts');
  assert.equal(m.segments[2]!.uri, 'https://cdn.test/video/shared/seg2.ts');
});

test('EXT-X-MEDIA-SEQUENCE dịch số thứ tự của MỌI segment, không riêng segment đầu', () => {
  const m = media(VOD.replace('#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-MEDIA-SEQUENCE:100'));
  assert.deepEqual(m.segments.map((s) => s.mediaSequence), [100, 101, 102]);
  // index vẫn đếm từ 0 vì nó là vị trí ghi ra file, khác hẳn số thứ tự dùng dựng IV.
  assert.deepEqual(m.segments.map((s) => s.index), [0, 1, 2]);
});

test('có EXT-X-ENDLIST nghĩa là VOD, tải được', () => {
  const m = media(VOD);
  assert.equal(m.hasEndList, true);
  assert.equal(m.isLive, false);
  assert.equal(m.playlistType, 'VOD');
});

test('thiếu EXT-X-ENDLIST nghĩa là danh sách còn đang mọc — phải coi là live', () => {
  const m = media(VOD.replace('#EXT-X-ENDLIST\n', '').replace('#EXT-X-PLAYLIST-TYPE:VOD\n', ''));
  assert.equal(m.isLive, true);
});

test('PLAYLIST-TYPE:EVENT mà chưa có ENDLIST vẫn là live — EVENT chỉ hứa không xóa segment cũ', () => {
  const m = media(
    VOD.replace('#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-PLAYLIST-TYPE:EVENT').replace('#EXT-X-ENDLIST\n', ''),
  );
  assert.equal(m.isLive, true);
  assert.equal(m.playlistType, 'EVENT');
});

test('khai PLAYLIST-TYPE:VOD thì tin, dù server quên EXT-X-ENDLIST', () => {
  const m = media(VOD.replace('#EXT-X-ENDLIST\n', ''));
  assert.equal(m.isLive, false);
});

test('dòng trống, CRLF và BOM không làm lệch kết quả', () => {
  const messy = `﻿#EXTM3U\r\n\r\n#EXT-X-TARGETDURATION:10\r\n\r\n#EXTINF:5,\r\na.ts\r\n#EXT-X-ENDLIST\r\n`;
  const m = media(messy);
  assert.equal(m.segments.length, 1);
  assert.equal(m.segments[0]!.uri, 'https://cdn.test/video/hd/a.ts');
  assert.equal(m.hasEndList, true);
});

test('dòng bình luận thuần không bị nhầm là tag', () => {
  const m = media(`#EXTM3U
# đây chỉ là ghi chú của packager
#EXTINF:5,
a.ts
#EXT-X-ENDLIST
`);
  assert.equal(m.segments.length, 1);
});

test('không có EXTINF nào thì báo no-segments thay vì trả về danh sách rỗng', () => {
  assert.throws(
    () => media('#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXT-X-ENDLIST\n'),
    (err: unknown) => err instanceof PlaylistError && err.code === 'no-segments',
  );
});

test('server trả trang HTML thay cho playlist thì báo not-m3u8, không cố đọc bừa', () => {
  assert.throws(
    () => parsePlaylist('<!DOCTYPE html>\n<html><body>Bạn cần đăng nhập</body></html>', BASE),
    (err: unknown) => err instanceof PlaylistError && err.code === 'not-m3u8',
  );
});

test('playlist rỗng báo lỗi empty', () => {
  assert.throws(
    () => parsePlaylist('   \n\n', BASE),
    (err: unknown) => err instanceof PlaylistError && err.code === 'empty',
  );
});

test('URI segment dùng scheme lạ bị từ chối — playlist là dữ liệu do server lạ cung cấp', () => {
  for (const evil of ['javascript:alert(1)', 'file:///etc/passwd', 'chrome-extension://abc/x.ts']) {
    assert.throws(
      () => media(`#EXTM3U\n#EXTINF:5,\n${evil}\n#EXT-X-ENDLIST\n`),
      (err: unknown) => err instanceof PlaylistError && err.code === 'bad-uri',
      `phải từ chối ${evil}`,
    );
  }
});

test('URI khóa dùng scheme lạ cũng bị từ chối', () => {
  assert.throws(
    () =>
      media(`#EXTM3U
#EXT-X-KEY:METHOD=AES-128,URI="file:///tmp/key.bin"
#EXTINF:5,
a.ts
#EXT-X-ENDLIST
`),
    (err: unknown) => err instanceof PlaylistError && err.code === 'bad-uri',
  );
});

test('dòng URI không có EXTINF đứng trước thì không phải segment', () => {
  const m = media(`#EXTM3U
lac-loai.ts
#EXTINF:5,
that.ts
#EXT-X-ENDLIST
`);
  assert.equal(m.segments.length, 1);
  assert.equal(m.segments[0]!.uri, 'https://cdn.test/video/hd/that.ts');
});

/* ---------- BYTERANGE ---------- */

test("BYTERANGE dạng 'n@o' đọc đúng cả độ dài lẫn offset", () => {
  assert.deepEqual(parseByteRange('75232@1024', null), { length: 75232, offset: 1024 });
});

test("BYTERANGE dạng 'n' thiếu offset thì nối tiếp ngay sau sub-range trước", () => {
  assert.deepEqual(parseByteRange('1000', 5000), { length: 1000, offset: 5000 });
});

test('BYTERANGE thiếu offset mà chưa có sub-range nào trước đó là không hợp lệ', () => {
  assert.equal(parseByteRange('1000', null), null);
});

test('ba sub-range liên tiếp trên cùng một URI cho ra ba khoảng không chồng lấn', () => {
  const m = media(`#EXTM3U
#EXT-X-VERSION:4
#EXT-X-TARGETDURATION:10
#EXTINF:5,
#EXT-X-BYTERANGE:1000@0
all.ts
#EXTINF:5,
#EXT-X-BYTERANGE:2000
all.ts
#EXTINF:5,
#EXT-X-BYTERANGE:3000
all.ts
#EXT-X-ENDLIST
`);
  assert.deepEqual(m.segments.map((s) => s.byteRange), [
    { length: 1000, offset: 0 },
    { length: 2000, offset: 1000 },
    { length: 3000, offset: 3000 },
  ]);
});

test('con trỏ BYTERANGE tính riêng cho từng URI, không lẫn giữa hai file', () => {
  const m = media(`#EXTM3U
#EXTINF:5,
#EXT-X-BYTERANGE:1000@0
a.ts
#EXTINF:5,
#EXT-X-BYTERANGE:500@0
b.ts
#EXTINF:5,
#EXT-X-BYTERANGE:700
a.ts
#EXT-X-ENDLIST
`);
  assert.deepEqual(m.segments[2]!.byteRange, { length: 700, offset: 1000 });
});

test('EXT-X-BYTERANGE đọc không ra thì báo lỗi, KHÔNG được lặng lẽ bỏ header Range', () => {
  // Bỏ header Range đi nghĩa là xin cả file: URI của playlist dạng BYTERANGE thường
  // trỏ tới nguyên file media vài GB, server trả HTTP 200 kèm cả file, và phép kiểm
  // 206 ở fetchSegment không chạy vì không còn range nào để kiểm. Cả bộ phim khi đó
  // được ghi vào chỗ của một segment — hỏng lặng lẽ, chỉ lộ ra sau khi tải xong.
  assert.throws(
    () => media('#EXTM3U\n#EXTINF:5,\n#EXT-X-BYTERANGE:khong-phai-so\nall.ts\n#EXT-X-ENDLIST\n'),
    (err: unknown) => err instanceof PlaylistError && err.code === 'bad-range',
  );
  // Offset ngầm mà trước đó chưa có sub-range nào của cùng URI cũng là playlist hỏng.
  assert.throws(
    () => media('#EXTM3U\n#EXTINF:5,\n#EXT-X-BYTERANGE:1000\nall.ts\n#EXT-X-ENDLIST\n'),
    (err: unknown) => err instanceof PlaylistError && err.code === 'bad-range',
  );
});

test('fMP4 một file: offset ngầm của segment đầu nối tiếp ngay sau EXT-X-MAP', () => {
  const m = media(`#EXTM3U
#EXT-X-MAP:URI="all.mp4",BYTERANGE="800@0"
#EXTINF:6,
#EXT-X-BYTERANGE:2000
all.mp4
#EXT-X-ENDLIST
`);
  assert.deepEqual(m.segments[0]!.byteRange, { length: 2000, offset: 800 });
  const reqs = buildSegmentRequests(m);
  assert.deepEqual(reqs[0]!.range, { start: 0, end: 799 });
  assert.deepEqual(reqs[1]!.range, { start: 800, end: 2799 });
});

test('BYTERANGE đổi thành cặp start/end inclusive của header Range', () => {
  const m = media(`#EXTM3U
#EXTINF:5,
#EXT-X-BYTERANGE:1000@2048
all.ts
#EXT-X-ENDLIST
`);
  const [req] = buildSegmentRequests(m);
  assert.deepEqual(req!.range, { start: 2048, end: 3047 });
});

/* ---------- EXT-X-KEY ---------- */

const ENCRYPTED = `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXT-X-KEY:METHOD=AES-128,URI="https://keys.test/k1.bin",IV=0x0123456789ABCDEF0123456789ABCDEF
#EXTINF:5,
a.ts
#EXTINF:5,
b.ts
#EXT-X-KEY:METHOD=AES-128,URI="k2.bin"
#EXTINF:5,
c.ts
#EXT-X-KEY:METHOD=NONE
#EXTINF:5,
d.ts
#EXT-X-ENDLIST
`;

test('EXT-X-KEY áp cho mọi segment phía sau tới khi gặp thẻ kế tiếp', () => {
  const m = media(ENCRYPTED);
  assert.equal(m.segments[0]!.key!.uri, 'https://keys.test/k1.bin');
  assert.equal(m.segments[1]!.key!.uri, 'https://keys.test/k1.bin');
  assert.equal(m.segments[2]!.key!.uri, 'https://cdn.test/video/hd/k2.bin');
});

test('METHOD=NONE gỡ mã hóa cho các segment đứng sau nó', () => {
  const m = media(ENCRYPTED);
  assert.equal(m.segments[3]!.key, null);
  assert.deepEqual([...m.encryption].sort(), ['AES-128', 'NONE']);
});

test('IV khai trong EXT-X-KEY parse ra đúng 16 byte', () => {
  const m = media(ENCRYPTED);
  const iv = m.segments[0]!.key!.iv!;
  assert.equal(iv.length, 16);
  assert.equal(hex(iv), '0123456789abcdef0123456789abcdef');
});

test('IV sai độ dài bị coi là không có, chứ không đoán bù — đoán bù cho IV sai lặng lẽ', () => {
  assert.equal(parseHexIv('0xABCD'), null);
  assert.equal(parseHexIv('0x' + 'a'.repeat(33)), null);
  assert.equal(parseHexIv('khong-phai-hex'), null);
  assert.equal(parseHexIv('0x' + 'a'.repeat(32))!.length, 16);
});

test('thẻ EXT-X-KEY sau đó không khai IV thì segment quay về dựng IV từ số thứ tự', () => {
  const m = media(ENCRYPTED);
  assert.equal(m.segments[2]!.key!.iv, null);
  assert.equal(hex(ivForSegment(m.segments[2]!)), '0'.repeat(30) + '02');
});

test('SAMPLE-AES bị chặn kèm lời giải thích, không im lặng cho tải rồi ra file hỏng', () => {
  const m = media(ENCRYPTED.replace('METHOD=AES-128,URI="https://keys.test/k1.bin"', 'METHOD=SAMPLE-AES,URI="https://keys.test/k1.bin"'));
  const key = m.segments[0]!.key!;
  assert.equal(key.method, 'SAMPLE-AES');
  assert.throws(
    () => assertSupported(key),
    (err: unknown) => err instanceof UnsupportedEncryptionError && /SAMPLE-AES/.test(err.message),
  );
});

test('KEYFORMAT của Widevine bị nhận ra là DRM và gọi đúng tên hệ DRM', () => {
  const m = media(`#EXTM3U
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="https://drm.test/lic",KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed",KEYFORMATVERSIONS="1"
#EXTINF:5,
a.ts
#EXT-X-ENDLIST
`);
  assert.throws(
    () => assertSupported(m.segments[0]!.key!),
    (err: unknown) => err instanceof UnsupportedEncryptionError && /Widevine/.test(err.message),
  );
});

test('URI khóa dạng skd:// (FairPlay) bị từ chối ngay ở tầng parse vì không phải http', () => {
  assert.throws(
    () =>
      media(`#EXTM3U
#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://asset-id"
#EXTINF:5,
a.ts
#EXT-X-ENDLIST
`),
    (err: unknown) => err instanceof PlaylistError && err.code === 'bad-uri',
  );
});

test('khóa AES-128 với KEYFORMAT lạ bị coi là DRM chứ không thử giải liều', () => {
  const key: KeyInfo = {
    method: 'AES-128',
    rawMethod: 'AES-128',
    uri: 'https://keys.test/k.bin',
    iv: null,
    keyFormat: 'com.example.custom',
    keyFormatVersions: '1',
  };
  assert.throws(() => assertSupported(key), UnsupportedEncryptionError);
});

test('METHOD=NONE luôn được chấp nhận', () => {
  const key: KeyInfo = {
    method: 'NONE',
    rawMethod: 'NONE',
    uri: null,
    iv: null,
    keyFormat: 'identity',
    keyFormatVersions: '1',
  };
  assert.doesNotThrow(() => assertSupported(key));
});

test('khóa nhúng dạng data: URI đọc được mà không cần gọi mạng', () => {
  const raw = new Uint8Array(16).map((_, i) => i * 7);
  assert.deepEqual(keyFromDataUri(`data:application/octet-stream;base64,${base64(raw)}`), raw);
  assert.equal(keyFromDataUri('https://keys.test/k.bin'), null);
  // Khóa sai độ dài phải bị từ chối, nếu không importKey sẽ nổ ở tận sau này.
  assert.equal(keyFromDataUri(`data:;base64,${base64(new Uint8Array(4))}`), null);
});

/* ---------- EXT-X-MAP và discontinuity ---------- */

const FMP4 = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:6
#EXT-X-MAP:URI="init.mp4"
#EXTINF:6,
seg1.m4s
#EXTINF:6,
seg2.m4s
#EXT-X-ENDLIST
`;

test('EXT-X-MAP gắn vào mọi segment sau nó và làm container thành fmp4', () => {
  const m = media(FMP4);
  assert.equal(m.container, 'fmp4');
  assert.equal(m.initSegments.length, 1);
  assert.equal(m.segments[0]!.map!.uri, 'https://cdn.test/video/hd/init.mp4');
  assert.equal(m.segments[1]!.map!.uri, 'https://cdn.test/video/hd/init.mp4');
});

test('init segment được chèn thành phần tử đầu của danh sách việc tải', () => {
  const reqs = buildSegmentRequests(media(FMP4));
  assert.equal(reqs.length, 3);
  assert.equal(reqs[0]!.isInit, true);
  assert.equal(reqs[0]!.url, 'https://cdn.test/video/hd/init.mp4');
  assert.deepEqual(reqs.map((r) => r.index), [0, 1, 2]);
  assert.equal(reqs[1]!.isInit, false);
});

test('playlist không có EXT-X-MAP thì việc tải bắt đầu thẳng từ segment đầu', () => {
  const reqs = buildSegmentRequests(media(VOD));
  assert.equal(reqs.length, 3);
  assert.equal(reqs[0]!.isInit, false);
});

test('hai EXT-X-MAP khác nhau thì nối thẳng cho ra file chỉ phát được đoạn đầu — phải chặn', () => {
  const m = media(`#EXTM3U
#EXT-X-MAP:URI="init-a.mp4"
#EXTINF:6,
a.m4s
#EXT-X-MAP:URI="init-b.mp4"
#EXTINF:6,
b.m4s
#EXT-X-ENDLIST
`);
  assert.equal(m.initSegments.length, 2);
  assert.equal(validateForConcat(m).length, 1);
  assert.notEqual(planAssembly(m, { separateAudio: false }).blocker, null);
});

test('cùng một EXT-X-MAP lặp lại nhiều lần chỉ tính là một init segment', () => {
  const m = media(`#EXTM3U
#EXT-X-MAP:URI="init.mp4"
#EXTINF:6,
a.m4s
#EXT-X-MAP:URI="init.mp4"
#EXTINF:6,
b.m4s
#EXT-X-ENDLIST
`);
  assert.equal(m.initSegments.length, 1);
  assert.deepEqual(validateForConcat(m), []);
});

test('EXT-X-DISCONTINUITY chỉ đánh dấu đúng segment đứng ngay sau nó', () => {
  const m = media(`#EXTM3U
#EXTINF:5,
a.ts
#EXT-X-DISCONTINUITY
#EXTINF:5,
b.ts
#EXTINF:5,
c.ts
#EXT-X-ENDLIST
`);
  assert.deepEqual(m.segments.map((s) => s.discontinuity), [false, true, false]);
  assert.equal(m.hasDiscontinuity, true);
});

test('segment EXT-X-GAP được đánh dấu để job bỏ qua thay vì tải rồi ăn 404', () => {
  const m = media(`#EXTM3U
#EXTINF:5,
a.ts
#EXT-X-GAP
#EXTINF:5,
b.ts
#EXT-X-ENDLIST
`);
  // planAssembly đã hứa với người dùng là chỗ đó sẽ trống; nếu request vẫn mang segment
  // gap đi tải thì lời hứa đó thành ra kéo sập cả lượt tải sau đủ số lần thử lại.
  assert.deepEqual(buildSegmentRequests(m).map((r) => r.gap), [false, true]);
});

test('đoán container theo đuôi file khi không có EXT-X-MAP', () => {
  assert.equal(detectContainer('https://c.test/a/seg.ts?token=1', false), 'mpegts');
  assert.equal(detectContainer('https://c.test/a/seg.m4s', false), 'fmp4');
  assert.equal(detectContainer('https://c.test/a/seg.aac', false), 'aac');
  assert.equal(detectContainer('https://c.test/a/seg.vtt', false), 'webvtt');
  // Segment sinh động không có đuôi: MPEG-TS là mặc định lịch sử của HLS, đoán
  // 'unknown' ở đây sẽ chặn oan phần lớn playlist thật.
  assert.equal(detectContainer('https://c.test/a/chunk/12345', false), 'mpegts');
  // EXT-X-MAP thắng mọi phép đoán theo đuôi.
  assert.equal(detectContainer('https://c.test/a/seg.ts', true), 'fmp4');
});

test('đuôi file quyết định đuôi của file kết quả', () => {
  assert.equal(containerExtension('fmp4'), '.mp4');
  assert.equal(containerExtension('mpegts'), '.ts');
  assert.equal(containerExtension('unknown'), '.bin');
});

/* ---------- Dựng IV ---------- */

test('IV mặc định luôn dài đúng 16 byte', () => {
  for (const seq of [0, 1, 255, 4096, 2 ** 31, 2 ** 40]) {
    assert.equal(ivFromSequence(seq).length, AES_BLOCK);
  }
});

test('số thứ tự 0 cho IV toàn số 0', () => {
  assert.equal(hex(ivFromSequence(0)), '0'.repeat(32));
});

test('số thứ tự 1 đặt byte CUỐI thành 1 — big-endian, không phải little', () => {
  const iv = ivFromSequence(1);
  assert.equal(iv[15], 1);
  assert.equal(iv[0], 0);
});

test('số thứ tự 258 cho hai byte cuối là 0102', () => {
  assert.equal(hex(ivFromSequence(258)).slice(-4), '0102');
});

test('số thứ tự lớn hơn 2^32 không bị cắt cụt', () => {
  // 2^40 = 0x010000000000, nằm ở byte thứ 11 tính từ trái — DataView.setUint32 sẽ mất nó.
  assert.equal(hex(ivFromSequence(2 ** 40)), '0'.repeat(20) + '010000000000');
});

test('ivForSegment ưu tiên IV khai trong EXT-X-KEY hơn số thứ tự', () => {
  const key: KeyInfo = {
    method: 'AES-128',
    rawMethod: 'AES-128',
    uri: 'https://keys.test/k.bin',
    iv: new Uint8Array(16).fill(0xaa),
    keyFormat: 'identity',
    keyFormatVersions: '1',
  };
  const segment: Segment = {
    index: 5,
    mediaSequence: 5,
    uri: 'https://cdn.test/a.ts',
    duration: 5,
    title: null,
    byteRange: null,
    key,
    map: null,
    discontinuity: false,
    gap: false,
  };
  assert.equal(hex(ivForSegment(segment)), 'aa'.repeat(16));

  const withoutIv: Segment = { ...segment, key: { ...key, iv: null } };
  assert.equal(hex(ivForSegment(withoutIv)).slice(-2), '05');
});

/* ---------- Giải mã AES-128 ---------- */

const RAW_KEY = new Uint8Array([
  0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef, 0xfe, 0xdc, 0xba, 0x98, 0x76, 0x54, 0x32, 0x10,
]);

async function importKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', src(RAW_KEY), 'AES-CBC', false, ['decrypt', 'encrypt']);
}

/** Mã hóa CBC rồi cắt bỏ block padding cuối — đúng thứ encoder thiếu chuẩn xuất ra. */
async function encryptWithoutPadding(
  plain: Uint8Array,
  key: CryptoKey,
  iv: Uint8Array,
): Promise<Uint8Array> {
  const full = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv: src(iv) }, key, src(plain)));
  return full.subarray(0, full.length - AES_BLOCK);
}

test('segment có padding PKCS#7 chuẩn giải mã ra đúng nguyên văn', async () => {
  const key = await importKey();
  const iv = ivFromSequence(42);
  const plain = new Uint8Array(1000).map((_, i) => (i * 31) & 0xff);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv: src(iv) }, key, src(plain)));

  assert.deepEqual(await decryptSegment(cipher, key, iv), plain);
});

test('segment KHÔNG có padding vẫn giải mã đúng nhờ block padding tổng hợp', async () => {
  const key = await importKey();
  const iv = ivFromSequence(7);
  // Bội số của 16 để encoder có cớ bỏ padding hẳn.
  const plain = new Uint8Array(1024).map((_, i) => (i * 17 + 3) & 0xff);
  const cipher = await encryptWithoutPadding(plain, key, iv);

  assert.equal(cipher.length % AES_BLOCK, 0);
  // Đường chuẩn phải hỏng, nếu không thì test này không kiểm được điều nó định kiểm.
  await assert.rejects(crypto.subtle.decrypt({ name: 'AES-CBC', iv: src(iv) }, key, src(cipher)));

  assert.deepEqual(await decryptWithoutPadding(cipher, key, iv), plain);
  assert.deepEqual(await decryptSegment(cipher, key, iv), plain);
});

test('bất biến 188 byte bắt được ca MPEG-TS bị cắt mất đuôi vì padding giả', async () => {
  const key = await importKey();
  const iv = ivFromSequence(9);

  // Dựng một segment TS không padding mà đuôi TÌNH CỜ trông giống padding hợp lệ:
  // đây chính là ca decrypt thẳng sẽ cắt nhầm vài byte và đi qua trong im lặng.
  const plain = new Uint8Array(188 * 4);
  for (let i = 0; i < plain.length; i += 188) plain[i] = 0x47; // sync byte của MPEG-TS
  plain[plain.length - 1] = 0x01; // padding PKCS#7 hợp lệ dài 1 byte

  const cipher = await encryptWithoutPadding(plain, key, iv);
  const naive = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: src(iv) }, key, src(cipher)));
  assert.equal(naive.length, plain.length - 1); // đúng là bị cắt mất một byte

  const fixed = await decryptSegment(cipher, key, iv, { expectMpegTs: true });
  assert.equal(fixed.length % 188, 0);
  assert.deepEqual(fixed, plain);
});

test('dữ liệu mã hóa không chia hết cho 16 nghĩa là segment tải thiếu, phải báo lỗi', async () => {
  const key = await importKey();
  await assert.rejects(
    decryptSegment(new Uint8Array(30), key, ivFromSequence(0)),
    /không chia hết/,
  );
});

test('KeyStore chỉ tải mỗi URI khóa đúng một lần dù hàng trăm segment cùng dùng', async () => {
  let calls = 0;
  const store = new KeyStore({
    fetchKey: async () => {
      calls += 1;
      return RAW_KEY;
    },
  });
  const key: KeyInfo = {
    method: 'AES-128',
    rawMethod: 'AES-128',
    uri: 'https://keys.test/k.bin',
    iv: null,
    keyFormat: 'identity',
    keyFormatVersions: '1',
  };

  const [a, b] = await Promise.all([store.get(key), store.get(key)]);
  await store.get(key);
  assert.equal(calls, 1);
  assert.equal(a, b);
});

test('khóa hỏng không bị đóng đinh trong cache — lần sau còn đường thử lại', async () => {
  let calls = 0;
  const store = new KeyStore({
    fetchKey: async () => {
      calls += 1;
      if (calls === 1) throw new Error('mạng chập');
      return RAW_KEY;
    },
  });
  const key: KeyInfo = {
    method: 'AES-128',
    rawMethod: 'AES-128',
    uri: 'https://keys.test/k.bin',
    iv: null,
    keyFormat: 'identity',
    keyFormatVersions: '1',
  };

  await assert.rejects(store.get(key), /mạng chập/);
  assert.ok(await store.get(key));
  assert.equal(calls, 2);
});

/* ---------- Kế hoạch ghép ---------- */

test('fMP4 ra thẳng .mp4, nối trực tiếp, không cảnh báo gì', () => {
  const plan = planAssembly(media(FMP4), { separateAudio: false });
  assert.equal(plan.output, 'mp4');
  assert.equal(plan.extension, '.mp4');
  assert.equal(plan.mimeType, 'video/mp4');
  assert.equal(plan.directConcat, true);
  assert.equal(plan.blocker, null);
  assert.deepEqual(plan.warnings, []);
});

test('MPEG-TS ra .ts kèm cảnh báo về trình phát — người dùng phải biết TRƯỚC khi chờ', () => {
  const plan = planAssembly(media(VOD), { separateAudio: false });
  assert.equal(plan.output, 'ts');
  assert.equal(plan.extension, '.ts');
  assert.equal(plan.directConcat, true);
  assert.equal(plan.blocker, null);
  assert.equal(plan.warnings.length, 1);
  assert.match(plan.warnings[0]!, /VLC/);
});

test('tiếng nằm ở luồng riêng thì cảnh báo file video sẽ câm', () => {
  const plan = planAssembly(media(FMP4), { separateAudio: true });
  assert.equal(plan.blocker, null);
  assert.ok(plan.warnings.some((w) => /KHÔNG có tiếng/.test(w)));
});

test('bản thân file tiếng thì không lặp lại cảnh báo câm, chỉ nói rõ là không có hình', () => {
  const plan = planAssembly(media(FMP4), { separateAudio: true, audioOnly: true });
  assert.equal(plan.warnings.some((w) => /KHÔNG có tiếng/.test(w)), false);
  assert.ok(plan.warnings.some((w) => /không có hình/.test(w)));
});

test('live bị chặn ngay ở bước lập kế hoạch, không tải một phần rồi treo', () => {
  const live = media(VOD.replace('#EXT-X-ENDLIST\n', '').replace('#EXT-X-PLAYLIST-TYPE:VOD\n', ''));
  const plan = planAssembly(live, { separateAudio: false });
  assert.match(plan.blocker ?? '', /trực tiếp/);
});

test('điểm gián đoạn chỉ là cảnh báo, không phải lý do từ chối tải', () => {
  const m = media(`#EXTM3U
#EXTINF:5,
a.ts
#EXT-X-DISCONTINUITY
#EXTINF:5,
b.ts
#EXT-X-ENDLIST
`);
  const plan = planAssembly(m, { separateAudio: false });
  assert.equal(plan.blocker, null);
  assert.ok(plan.warnings.some((w) => /gián đoạn/.test(w)));
});

test('EXT-X-GAP được đếm và báo cho người dùng biết file sẽ thiếu đoạn', () => {
  const m = media(`#EXTM3U
#EXTINF:5,
a.ts
#EXT-X-GAP
#EXTINF:5,
b.ts
#EXT-X-ENDLIST
`);
  assert.equal(m.segments[1]!.gap, true);
  assert.ok(planAssembly(m, { separateAudio: false }).warnings.some((w) => /thiếu/.test(w)));
});

test('luồng phụ đề bị chặn vì đây không phải video', () => {
  const m = media(`#EXTM3U
#EXTINF:5,
a.vtt
#EXT-X-ENDLIST
`);
  assert.equal(m.container, 'webvtt');
  assert.notEqual(planAssembly(m, { separateAudio: false }).blocker, null);
});

test('container không nhận ra thì từ chối nối liều', () => {
  const m = media(`#EXTM3U
#EXTINF:5,
a.xyz
#EXT-X-ENDLIST
`);
  assert.equal(m.container, 'unknown');
  assert.equal(planAssembly(m, { separateAudio: false }).directConcat, false);
  assert.notEqual(planAssembly(m, { separateAudio: false }).blocker, null);
});

/* ---------- OrderedSink ---------- */

class MemorySink implements ChunkSink {
  readonly chunks: Uint8Array[] = [];
  append(chunk: Uint8Array): Promise<number> {
    this.chunks.push(chunk);
    return Promise.resolve(this.chunks.length);
  }
}

test('segment xong lộn xộn vẫn được ghi đúng thứ tự', async () => {
  const sink = new MemorySink();
  const ordered = new OrderedSink(sink, { maxBufferedBytes: 1024, total: 4 });

  await ordered.put(3, Uint8Array.of(3));
  await ordered.put(1, Uint8Array.of(1));
  assert.deepEqual(sink.chunks, []); // chưa có segment 0 thì chưa được ghi gì

  await ordered.put(0, Uint8Array.of(0));
  await ordered.put(2, Uint8Array.of(2));

  assert.deepEqual(sink.chunks.map((c) => c[0]), [0, 1, 2, 3]);
  assert.equal(ordered.done, true);
  assert.equal(ordered.bufferedBytes, 0);
});

test('bộ đệm đầy thì hasRoom tắt để bên gọi ngừng phát segment mới', async () => {
  const sink = new MemorySink();
  const ordered = new OrderedSink(sink, { maxBufferedBytes: 10, total: 3 });

  await ordered.put(1, new Uint8Array(20));
  assert.equal(ordered.hasRoom, false);
  assert.equal(ordered.bufferedBytes, 20);

  await ordered.put(0, new Uint8Array(1));
  // Cả hai đã xuống đĩa nên đệm trống trở lại.
  assert.equal(ordered.hasRoom, true);
  assert.equal(ordered.nextIndex, 2);
});

test('đặt lại cùng một segment sau khi thử lại không làm phình số byte đang đệm', async () => {
  const sink = new MemorySink();
  const ordered = new OrderedSink(sink, { maxBufferedBytes: 100, total: 2 });

  await ordered.put(1, new Uint8Array(40));
  await ordered.put(1, new Uint8Array(40));
  assert.equal(ordered.bufferedBytes, 40);
});

test('segment đã ghi rồi thì bỏ qua, không ghi trùng vào file', async () => {
  const sink = new MemorySink();
  const ordered = new OrderedSink(sink, { maxBufferedBytes: 100, total: 2 });

  await ordered.put(0, Uint8Array.of(0));
  await ordered.put(0, Uint8Array.of(0));
  assert.equal(sink.chunks.length, 1);
});

/** Sink giữ mỗi lần append lại cho tới khi test tự nhả, để dựng đúng ca ghi đang dở. */
class GatedSink implements ChunkSink {
  readonly written: number[] = [];
  private readonly release: Array<() => void> = [];

  append(chunk: Uint8Array): Promise<number> {
    this.written.push(chunk[0] ?? -1);
    return new Promise<number>((resolve) => {
      this.release.push(() => resolve(this.written.length));
    });
  }

  flushOne(): void {
    this.release.shift()?.();
  }
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

test('tạm dừng đúng lúc một segment đang ghi dở không làm segment đó nằm hai lần trong file', async () => {
  const gated = new GatedSink();
  const ordered = new OrderedSink(gated, { maxBufferedBytes: 1000, total: 3 });

  const first = ordered.put(0, Uint8Array.of(0));
  await tick();
  assert.deepEqual(gated.written, [0]);
  // Con trỏ vẫn ở 0: lệnh ghi đã đi nhưng chưa có biên nhận, đúng thời điểm pause()
  // chụp lấy nextIndex rồi reset.
  assert.equal(ordered.nextIndex, 0);

  ordered.reset(ordered.nextIndex);
  // resume(): pause đã trả piece 0 về hàng chờ nên nó được tải lại và đặt lại vào sink.
  const again = ordered.put(0, Uint8Array.of(9));
  await tick();
  // Lần ghi thứ hai KHÔNG được phép chạy song song với lần ghi còn đang bay: mỗi lời
  // gọi append nhận một offset riêng, nên hai lời gọi cùng lúc là segment 0 nằm hai lần
  // trong file và segment 1 thì biến mất.
  assert.deepEqual(gated.written, [0]);

  gated.flushOne();
  await first;
  await again;
  await tick();

  assert.deepEqual(gated.written, [0]);
  assert.equal(ordered.nextIndex, 1);
  // Bản sao bị bỏ cũng phải rời khỏi bộ đệm, nếu không trần đệm co lại vĩnh viễn.
  assert.equal(ordered.bufferedBytes, 0);
});

test('chunk còn đang trên đường xuống đĩa vẫn tính vào bộ đệm — nó vẫn chiếm RAM thật', async () => {
  const gated = new GatedSink();
  const ordered = new OrderedSink(gated, { maxBufferedBytes: 10, total: 2 });

  const first = ordered.put(0, new Uint8Array(16));
  await tick();
  assert.equal(ordered.bufferedBytes, 16);
  assert.equal(ordered.hasRoom, false);

  gated.flushOne();
  await first;
  assert.equal(ordered.bufferedBytes, 0);
  assert.equal(ordered.hasRoom, true);
});

test('reset nhả sạch RAM và đưa con trỏ về đúng chỗ đang dở', async () => {
  const sink = new MemorySink();
  const ordered = new OrderedSink(sink, { maxBufferedBytes: 1000, total: 5 });

  await ordered.put(0, new Uint8Array(10));
  await ordered.put(3, new Uint8Array(10));
  assert.equal(ordered.bufferedBytes, 10);

  ordered.reset(ordered.nextIndex);
  assert.equal(ordered.bufferedBytes, 0);
  assert.equal(ordered.nextIndex, 1);
});

/* ---------- Nhận biết URL media ---------- */

test('nhận ra .m3u8 kể cả khi nó nằm trong query string', () => {
  assert.equal(classifyMediaUrl('https://c.test/hls/master.m3u8'), 'hls');
  assert.equal(classifyMediaUrl('https://c.test/play?file=abc.m3u8&token=xyz'), 'hls');
  assert.equal(classifyMediaUrl('https://c.test/x.m3u8?a=1'), 'hls');
  assert.equal(classifyMediaUrl('https://c.test/play?f=abc%2Em3u8'), 'hls');
});

test('nhận ra DASH để còn nói thẳng là chưa hỗ trợ, thay vì im lặng bỏ qua', () => {
  assert.equal(classifyMediaUrl('https://c.test/dash/manifest.mpd'), 'dash');
});

test('URL thường không bị nhận nhầm là playlist', () => {
  assert.equal(classifyMediaUrl('https://c.test/video.mp4'), 'unknown');
  // Không được khớp .m3u8 nằm giữa một từ dài hơn.
  assert.equal(classifyMediaUrl('https://c.test/a.m3u8x'), 'unknown');
  assert.equal(classifyMediaUrl('khong-phai-url'), 'unknown');
});
