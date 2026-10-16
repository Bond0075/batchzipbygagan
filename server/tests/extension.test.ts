/**
 * Extension detection tests: priority order, sanitization, sniffing,
 * and Content-Disposition parsing.
 */
import { describe, it, expect } from "vitest";
import {
  determineExtension,
  extensionFromContentDisposition,
  extensionFromUrlPath,
  filenameFromContentDisposition,
  sanitizeFilename,
  sniffExtension,
  looksLikeHtml,
} from "../src/utils/extension.js";
import { MAGIC } from "./fixtures.js";

describe("extension priority", () => {
  it("prefers Content-Disposition over the URL path", () => {
    const r = determineExtension({
      contentDisposition: 'attachment; filename="song.mp3"',
      url: new URL("https://example.com/download/file.wav"),
    });
    expect(r.extension).toBe("mp3");
    expect(r.source).toBe("content-disposition");
  });

  it("falls back to the URL path", () => {
    const r = determineExtension({
      contentDisposition: null,
      url: new URL("https://example.com/audio-a.wav?token=abc"),
    });
    expect(r.extension).toBe("wav");
    expect(r.source).toBe("url-path");
  });

  it("never uses query parameters as the extension", () => {
    expect(extensionFromUrlPath(new URL("https://example.com/dl?format=mp3"))).toBeNull();
  });

  it("falls back to content sniffing", () => {
    const r = determineExtension({
      contentDisposition: null,
      url: new URL("https://example.com/stream/abc123"),
      sniffHead: MAGIC.png,
    });
    expect(r.extension).toBe("png");
    expect(r.source).toBe("content-sniff");
  });

  it("warns when no extension can be established", () => {
    const r = determineExtension({
      contentDisposition: null,
      url: new URL("https://example.com/stream/abc123"),
      sniffHead: Buffer.from("totally unknown binary blob \x00\x01"),
    });
    expect(r.extension).toBeNull();
    expect(r.source).toBe("unknown");
    expect(r.warning).toMatch(/could not determine/i);
  });
});

describe("sanitization", () => {
  it("strips path traversal from filenames", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("..\\..\\secret.txt")).toBe("secret.txt");
  });

  it("strips control characters and leading dots", () => {
    expect(sanitizeFilename("...hidden.mp3")).toBe("hidden.mp3");
    expect(sanitizeFilename("a\x00b.mp3")).toBe("ab.mp3");
  });

  it("parses RFC 5987 encoded filenames", () => {
    expect(filenameFromContentDisposition("attachment; filename*=UTF-8''report%20final.pdf")).toBe(
      "report final.pdf"
    );
  });

  it("parses quoted filenames", () => {
    expect(filenameFromContentDisposition('attachment; filename="my song.mp3"')).toBe("my song.mp3");
  });

  it("rejects unknown/odd extensions", () => {
    expect(extensionFromContentDisposition('attachment; filename="x.unknownext"')).toBeNull();
  });
});

describe("sniffing", () => {
  it("detects common formats from magic bytes", () => {
    expect(sniffExtension(MAGIC.wav)).toBe("wav");
    expect(sniffExtension(MAGIC.mp3)).toBe("mp3");
    expect(sniffExtension(MAGIC.pdf)).toBe("pdf");
    expect(sniffExtension(MAGIC.png)).toBe("png");
    expect(sniffExtension(MAGIC.zip)).toBe("zip");
  });

  it("detects HTML masquerade pages", () => {
    expect(looksLikeHtml(Buffer.from("<!DOCTYPE html><html>nope"))).toBe(true);
    expect(looksLikeHtml(MAGIC.wav)).toBe(false);
  });
});
