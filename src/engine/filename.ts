/** Suy ra và làm sạch tên file từ phản hồi HTTP. */

// Dựng bằng RegExp constructor để không nhúng ký tự điều khiển thật vào mã nguồn.
const ILLEGAL = new RegExp('[\\u0000-\\u001F\\u007F<>:"/\\\\|?*]', 'g');
const RESERVED_WINDOWS = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** Cắt bỏ đường dẫn và ký tự cấm để tên file không thể thoát ra ngoài thư mục tải. */
export function sanitize(name: string): string {
  let out = name.replace(/^.*[\\/]/, '').replace(ILLEGAL, '_').trim();
  out = out.replace(/^\.+/, '').replace(/[. ]+$/, '');
  if (!out) out = 'download';
  if (RESERVED_WINDOWS.test(out)) out = `_${out}`;
  // Chừa chỗ cho hậu tố chống trùng mà không vượt giới hạn tên file phổ biến.
  return out.length > 200 ? out.slice(0, 200) : out;
}

/**
 * Đọc header Content-Disposition. Ưu tiên `filename*` theo RFC 5987 vì nó mang
 * thông tin bảng mã, còn `filename` thuần thường vỡ với tên không phải ASCII.
 */
export function fromContentDisposition(header: string | null): string | null {
  if (!header) return null;

  const extended = /filename\*\s*=\s*([^']*)'([^']*)'([^;]+)/i.exec(header);
  if (extended?.[3]) {
    try {
      return sanitize(decodeURIComponent(extended[3].trim()));
    } catch {
      // Chuỗi mã hóa hỏng thì bỏ qua, rơi xuống nhánh filename thuần.
    }
  }

  const quoted = /filename\s*=\s*"((?:[^"\\]|\\.)*)"/i.exec(header);
  if (quoted?.[1]) return sanitize(quoted[1].replace(/\\(.)/g, '$1'));

  const bare = /filename\s*=\s*([^;]+)/i.exec(header);
  if (bare?.[1]) return sanitize(bare[1].trim());

  return null;
}

/** Rút tên file từ đường dẫn URL khi server không nói gì. */
export function fromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split('/').filter(Boolean).pop();
    if (last) return sanitize(decodeURIComponent(last));
    return sanitize(parsed.hostname || 'download');
  } catch {
    return 'download';
  }
}

export function resolveFilename(url: string, contentDisposition: string | null): string {
  return fromContentDisposition(contentDisposition) ?? fromUrl(url);
}
