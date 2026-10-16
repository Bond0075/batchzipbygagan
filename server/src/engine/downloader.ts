/**
 * Single-file download with retries and verification.
 *
 * The batch runner (jobRunner.ts) calls this once per URL, strictly in order.
 * This module never downloads two files at once and never reorders anything —
 * it only handles: attempt → stream to disk → verify → retry on failure.
 */
import { createWriteStream, promises as fs } from "node:fs";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { config } from "../config.js";
import { safeFetch, HttpError, isRetryableStatus, describeStatus } from "./http.js";
import {
  determineExtension,
  looksLikeHtml,
  sanitizeFilename,
} from "../utils/extension.js";
import type { FileItem } from "../types.js";

export interface DownloadCallbacks {
  onAttemptStart?: (attempt: number) => void;
  onProgress?: (bytes: number) => void;
  shouldCancel?: () => boolean;
  signal?: AbortSignal;
}

export interface DownloadResult {
  ok: boolean;
  bytes: number;
  expectedBytes: number | null;
  extension: string | null;
  extensionSource: FileItem["extensionSource"];
  extensionWarning: string | null;
  tempPath: string | null;
  error: string | null;
  errorHistory: { attempt: number; error: string; at: string }[];
  attempts: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function backoffDelayMs(attemptIndex: number): number {
  // attemptIndex 0 = after the first failure
  const exp = config.retryBaseDelayMs * 2 ** attemptIndex;
  const jitter = Math.floor(Math.random() * 500);
  return Math.min(exp + jitter, 30_000);
}

/**
 * Classify an error: should we retry, and what should the user see?
 * Non-retryable: SSRF blocks, 4xx (except 408/429), bad URLs, HTML masquerade,
 * zero-byte, extension-unknown, cancelled.
 */
export function classifyFailure(err: unknown, status?: number): { retryable: boolean; message: string } {
  if (err instanceof DOMException && err.name === "AbortError") {
    const reason = (err as any).cause ?? err.message;
    if (String(reason).toLowerCase().includes("cancel")) {
      return { retryable: false, message: "Cancelled by user" };
    }
    return { retryable: true, message: `Timed out after ${config.requestTimeoutMs / 1000}s` };
  }
  if (err instanceof Error && err.name === "SsrfError") {
    return { retryable: false, message: `Blocked: ${err.message}` };
  }
  if (err instanceof HttpError) {
    if (status !== undefined && !isRetryableStatus(status)) {
      return { retryable: false, message: describeStatus(status) };
    }
    return { retryable: true, message: describeStatus(err.status) };
  }
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (msg.includes("exceeded") && msg.includes("size")) {
      return { retryable: false, message: err.message };
    }
    if (msg.includes("truncat") || msg.includes("incomplete")) {
      return { retryable: true, message: err.message };
    }
    if (msg.includes("econnreset") || msg.includes("socket") || msg.includes("network") || msg.includes("fetch failed") || msg.includes("terminated")) {
      return { retryable: true, message: `Network error: ${err.message}` };
    }
    return { retryable: true, message: err.message };
  }
  return { retryable: true, message: String(err) };
}

/**
 * Download one URL to a temp file, with verification and retries.
 *
 * @param rawUrl        the user-supplied URL
 * @param position      immutable 1-based position (for temp naming only)
 * @param tmpDir        directory for temp files
 * @param maxBytes      per-file byte cap for this attempt
 */
export async function downloadOne(
  rawUrl: string,
  position: number,
  tmpDir: string,
  maxBytes: number,
  cb: DownloadCallbacks = {}
): Promise<DownloadResult> {
  const errorHistory: { attempt: number; error: string; at: string }[] = [];
  const maxAttempts = 1 + config.retryCount;
  let lastError: string | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (cb.shouldCancel?.()) {
      return fail("Cancelled by user", errorHistory, attempt - 1, maxBytes);
    }
    cb.onAttemptStart?.(attempt);

    const tmpName = `pos-${position}-attempt-${attempt}-${Date.now()}.part`;
    const tmpFile = path.join(tmpDir, tmpName);

    try {
      const res = await attemptDownload(rawUrl, tmpFile, maxBytes, cb);

      // ---- Verification ----
      const verification = await verifyDownloadedFile(tmpFile, res);
      if (!verification.ok) {
        await fs.rm(tmpFile, { force: true });
        throw new Error(verification.error!);
      }

      return {
        ok: true,
        bytes: res.bytes,
        expectedBytes: res.expectedBytes,
        extension: res.extension,
        extensionSource: res.extensionSource,
        extensionWarning: res.extensionWarning,
        tempPath: tmpFile,
        error: null,
        errorHistory,
        attempts: attempt,
      };
    } catch (err) {
      await fs.rm(tmpFile, { force: true }).catch(() => {});
      const { retryable, message } = classifyFailure(err, (err as HttpError)?.status);
      lastError = message;
      errorHistory.push({ attempt, error: message, at: new Date().toISOString() });

      const cancelled = message.toLowerCase().includes("cancel");
      if (cancelled || !retryable || attempt === maxAttempts) {
        return fail(message, errorHistory, attempt, maxBytes);
      }
      // Wait with exponential backoff before the next attempt.
      const delay = backoffDelayMs(attempt - 1);
      await sleep(delay);
    }
  }

  return fail(lastError ?? "Unknown error", errorHistory, maxAttempts, maxBytes);
}

function fail(
  message: string,
  errorHistory: DownloadResult["errorHistory"],
  attempts: number,
  _maxBytes: number
): DownloadResult {
  void _maxBytes;
  return {
    ok: false,
    bytes: 0,
    expectedBytes: null,
    extension: null,
    extensionSource: null,
    extensionWarning: null,
    tempPath: null,
    error: message,
    errorHistory,
    attempts,
  };
}

interface AttemptResult {
  bytes: number;
  expectedBytes: number | null;
  extension: string | null;
  extensionSource: FileItem["extensionSource"];
  extensionWarning: string | null;
  head: Buffer;
  contentType: string | null;
}

async function attemptDownload(
  rawUrl: string,
  tmpFile: string,
  maxBytes: number,
  cb: DownloadCallbacks
): Promise<AttemptResult> {
  const res = await safeFetch(rawUrl, { signal: cb.signal });

  try {
    if (res.status < 200 || res.status >= 300) {
      throw new HttpError(res.status, describeStatus(res.status));
    }
    if (!res.body) {
      throw new HttpError(res.status, "Empty response body");
    }

    const contentLengthRaw = res.headers.get("content-length");
    const contentEncoding = (res.headers.get("content-encoding") || "").toLowerCase();
    let expectedBytes: number | null = null;
    if (contentLengthRaw !== null) {
      const n = Number(contentLengthRaw);
      // Only trust Content-Length when the encoding allows an exact byte
      // comparison (no compression/transform in transit).
      if (
        Number.isInteger(n) &&
        n >= 0 &&
        (contentEncoding === "" || contentEncoding === "identity")
      ) {
        expectedBytes = n;
      }
    }
    if (expectedBytes !== null && expectedBytes === 0) {
      throw new Error("Server reported a zero-byte file (Content-Length: 0)");
    }
    if (expectedBytes !== null && expectedBytes > maxBytes) {
      throw new Error(
        `File too large: server reports ${formatBytes(expectedBytes)} (limit ${formatBytes(maxBytes)})`
      );
    }

    const contentDisposition = res.headers.get("content-disposition");
    const contentType = res.headers.get("content-type");
    const finalUrl = new URL(res.finalUrl);

    // Pre-determine extension from headers/URL (sniffing comes after we have bytes).
    const early = determineExtension({ contentDisposition, url: finalUrl });

    let bytes = 0;
    const headChunks: Buffer[] = [];
    let headBytes = 0;
    const HEAD_CAP = 8192;

    const counter = new Transform({
      transform(chunk: Buffer, _enc, done) {
        bytes += chunk.length;
        if (bytes > maxBytes) {
          done(new Error(`File exceeded the per-file size limit of ${formatBytes(maxBytes)}`));
          return;
        }
        if (headBytes < HEAD_CAP) {
          const take = Math.min(chunk.length, HEAD_CAP - headBytes);
          headChunks.push(chunk.subarray(0, take));
          headBytes += take;
        }
        cb.onProgress?.(bytes);
        done(null, chunk);
      },
    });

    const fileStream = createWriteStream(tmpFile);
    const webStream = res.body as unknown as NodeJS.ReadableStream;

    try {
      await pipeline(webStream as any, counter, fileStream);
    } catch (e) {
      // pipeline failure mid-stream = truncated/incomplete transfer
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.toLowerCase().includes("exceed")) throw e;
      throw new Error(`Incomplete transfer after ${formatBytes(bytes)}: ${msg}`);
    }

    if (bytes === 0) {
      throw new Error("Downloaded file is empty (0 bytes)");
    }

    // Truncation check: only when Content-Length was trustworthy.
    if (expectedBytes !== null && bytes !== expectedBytes) {
      throw new Error(
        `Truncated transfer: received ${formatBytes(bytes)} but server declared ${formatBytes(expectedBytes)}`
      );
    }

    const head = Buffer.concat(headChunks);

    // Final extension determination with content sniffing fallback.
    const determined = determineExtension({ contentDisposition, url: finalUrl, sniffHead: head });

    return {
      bytes,
      expectedBytes,
      extension: determined.extension,
      extensionSource: determined.source,
      extensionWarning: determined.warning ?? early.warning,
      head,
      contentType,
    };
  } finally {
    await res.body?.cancel().catch(() => {});
  }
}

interface Verification {
  ok: boolean;
  error?: string;
}

/** Post-download verification: existence, size, HTML masquerade, type sanity. */
async function verifyDownloadedFile(tmpFile: string, res: AttemptResult): Promise<Verification> {
  let stat;
  try {
    stat = await fs.stat(tmpFile);
  } catch {
    return { ok: false, error: "Downloaded file is missing from disk" };
  }
  if (!stat.isFile()) return { ok: false, error: "Downloaded path is not a file" };
  if (stat.size === 0) return { ok: false, error: "Downloaded file is empty (0 bytes)" };
  if (stat.size !== res.bytes) {
    return {
      ok: false,
      error: `Size mismatch on disk: expected ${res.bytes} bytes, found ${stat.size}`,
    };
  }

  // Never accept an HTML error page as a successful download (unless the
  // extension genuinely is html/htm).
  const ext = res.extension;
  if (ext && ext !== "html" && ext !== "htm" && looksLikeHtml(res.head)) {
    const ct = res.contentType ? ` (Content-Type: ${res.contentType})` : "";
    return {
      ok: false,
      error: `Server returned an HTML page instead of the expected .${ext} file${ct}`,
    };
  }

  return { ok: true };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[u]}`;
}

export { sanitizeFilename };
