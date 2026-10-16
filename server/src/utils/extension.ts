/**
 * File extension determination with the required priority:
 *   1. Valid extension from HTTP Content-Disposition filename
 *   2. Extension from the URL path
 *   3. Content sniffing (magic bytes) as a fallback
 *
 * Never uses query parameters. Sanitizes everything and never trusts
 * Content-Type / Content-Disposition blindly.
 */
import * as path from "node:path";

const MAX_EXT_LEN = 10;
// Extensions we consider meaningful for naming; anything else is ignored so
// we fall through to the next source. Deliberately generous but safe.
const KNOWN_EXTENSIONS = new Set(
  "3gp 7z aac aiff ape asf ass avi avif bin bmp bz2 cbr cbz css csv dmg doc docx epub exe flac gif gz heic heif htm html ico jpe jpeg jpg js json lha lz m4a m4v md mid midi mkv mov mp3 mp4 mpeg mpg msi odb ods odt ogg ogv opus otf pdf png ppt pptx psd rar rtf srt sub svg swf tar tbz tgz tif tiff ttf txt vtt wav webm webp wma wmv woff woff2 xls xlsx xml xz zip zst".split(
    " "
  )
);

export type ExtensionSource = "content-disposition" | "url-path" | "content-sniff" | "unknown";

export interface ExtensionResult {
  extension: string | null; // without dot, lowercase
  source: ExtensionSource;
  warning: string | null;
}

/** Strip path tricks, control chars and quotes from a candidate filename. */
export function sanitizeFilename(name: string): string {
  let n = name.trim();
  // Remove any directory components (both separators)
  n = n.split("/").pop()!.split("\\").pop()!;
  // Remove control characters and a few dangerous specials
  n = n.replace(/[\x00-\x1f\x7f<>:"|?*]/g, "");
  n = n.replace(/^\.+/, ""); // no leading dots (hidden files / "..")
  if (n.length > 200) n = n.slice(0, 200);
  return n;
}

function extFromName(name: string): string | null {
  const clean = sanitizeFilename(name);
  const dot = clean.lastIndexOf(".");
  if (dot <= 0 || dot === clean.length - 1) return null;
  const ext = clean.slice(dot + 1).toLowerCase();
  if (ext.length > MAX_EXT_LEN || !/^[a-z0-9]+$/.test(ext)) return null;
  if (!KNOWN_EXTENSIONS.has(ext)) return null;
  return ext;
}

/** Parse RFC 6266 / RFC 5987 Content-Disposition for a filename. */
export function filenameFromContentDisposition(header: string | null | undefined): string | null {
  if (!header) return null;
  // filename*=UTF-8''... (RFC 5987)
  const star = header.match(/filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/);
  if (star) {
    try {
      return sanitizeFilename(decodeURIComponent(star[1].trim().replace(/^"|"$/g, "")));
    } catch {
      /* fall through */
    }
  }
  // filename="..." or filename=...
  const plain = header.match(/filename\s*=\s*("([^"]*)"|([^;]*))/i);
  if (plain) {
    const name = (plain[2] ?? plain[3] ?? "").trim();
    if (name) return sanitizeFilename(name);
  }
  return null;
}

export function extensionFromContentDisposition(
  header: string | null | undefined
): string | null {
  const name = filenameFromContentDisposition(header);
  return name ? extFromName(name) : null;
}

export function extensionFromUrlPath(url: URL): string | null {
  try {
    const base = path.posix.basename(url.pathname);
    return extFromName(base);
  } catch {
    return null;
  }
}

// ---- Magic-byte sniffing (first bytes of the downloaded file) ----

interface MagicRule {
  ext: string;
  test: (b: Buffer) => boolean;
}

const MAGIC_RULES: MagicRule[] = [
  { ext: "png", test: (b) => b.length >= 8 && b[0] === 0x89 && b.toString("ascii", 1, 4) === "PNG" },
  { ext: "jpg", test: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: "gif", test: (b) => b.length >= 6 && (b.toString("ascii", 0, 6) === "GIF87a" || b.toString("ascii", 0, 6) === "GIF89a") },
  { ext: "webp", test: (b) => b.length >= 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP" },
  { ext: "pdf", test: (b) => b.length >= 5 && b.toString("ascii", 0, 5) === "%PDF-" },
  { ext: "zip", test: (b) => b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07) && (b[3] === 0x04 || b[3] === 0x06 || b[3] === 0x08) },
  { ext: "gz", test: (b) => b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b },
  { ext: "bz2", test: (b) => b.length >= 3 && b.toString("ascii", 0, 3) === "BZh" },
  { ext: "xz", test: (b) => b.length >= 6 && b[0] === 0xfd && b.toString("ascii", 1, 6) === "7zXZ\x00" },
  { ext: "7z", test: (b) => b.length >= 6 && b.toString("ascii", 0, 6) === "7z\xbc\xaf\x27\x1c" },
  { ext: "rar", test: (b) => b.length >= 7 && b.toString("ascii", 0, 7) === "Rar!\x1a\x07\x00" },
  { ext: "mp3", test: (b) => b.length >= 3 && (b.toString("ascii", 0, 3) === "ID3" || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) },
  { ext: "wav", test: (b) => b.length >= 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WAVE" },
  { ext: "flac", test: (b) => b.length >= 4 && b.toString("ascii", 0, 4) === "fLaC" },
  { ext: "ogg", test: (b) => b.length >= 4 && b.toString("ascii", 0, 4) === "OggS" },
  { ext: "mp4", test: (b) => b.length >= 12 && b.toString("ascii", 4, 8) === "ftyp" },
  { ext: "avi", test: (b) => b.length >= 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "AVI " },
  { ext: "mkv", test: (b) => b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3 },
  { ext: "bmp", test: (b) => b.length >= 2 && b.toString("ascii", 0, 2) === "BM" },
  { ext: "tiff", test: (b) => b.length >= 4 && (b.toString("ascii", 0, 4) === "II*\x00" || b.toString("ascii", 0, 4) === "MM\x00*") },
  { ext: "ico", test: (b) => b.length >= 4 && b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x00 },
];

export function sniffExtension(head: Buffer): string | null {
  for (const rule of MAGIC_RULES) {
    try {
      if (rule.test(head)) return rule.ext;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/**
 * Determine the extension using the required priority. Returns a warning
 * when the extension cannot be established reliably (caller should surface
 * this to the user before starting the job).
 */
export function determineExtension(input: {
  contentDisposition: string | null | undefined;
  url: URL;
  sniffHead?: Buffer;
}): ExtensionResult {
  const fromCd = extensionFromContentDisposition(input.contentDisposition);
  if (fromCd) return { extension: fromCd, source: "content-disposition", warning: null };

  const fromPath = extensionFromUrlPath(input.url);
  if (fromPath) return { extension: fromPath, source: "url-path", warning: null };

  if (input.sniffHead) {
    const sniffed = sniffExtension(input.sniffHead);
    if (sniffed) return { extension: sniffed, source: "content-sniff", warning: null };
  }

  return {
    extension: null,
    source: "unknown",
    warning:
      "Could not determine a file extension from Content-Disposition, the URL path, or the file contents. " +
      "Decide how to handle this URL (skip it, or provide an extension) before starting the job.",
  };
}

/** Human-friendly check: is this an HTML error page masquerading as a download? */
export function looksLikeHtml(head: Buffer): boolean {
  const text = head.slice(0, 512).toString("utf8").trimStart().toLowerCase();
  return (
    text.startsWith("<!doctype html") ||
    text.startsWith("<html") ||
    text.startsWith("<head") ||
    text.startsWith("<body")
  );
}
