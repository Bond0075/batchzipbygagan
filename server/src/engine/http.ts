/**
 * Safe HTTP fetching for user-supplied URLs.
 *
 * - Manual redirect handling: every Location hop is re-validated through the
 *   SSRF checker (scheme + DNS + IP class), defeating redirect-based SSRF
 *   and DNS-rebinding attacks.
 * - Per-attempt timeout via AbortController.
 * - Streams the body so we can enforce byte limits while downloading.
 */
import { validateUrl, SsrfError } from "../security/ssrf.js";
import { config } from "../config.js";

export interface SafeResponse {
  finalUrl: string;
  status: number;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
  redirectChain: string[];
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

export function describeStatus(status: number): string {
  const map: Record<number, string> = {
    400: "Bad request",
    401: "Unauthorized (login required)",
    403: "Forbidden — the server refused access",
    404: "Not found",
    408: "Request timeout",
    410: "Gone — the file was removed",
    429: "Rate limited — the server asked us to slow down",
    500: "Server error",
    502: "Bad gateway",
    503: "Service unavailable",
    504: "Gateway timeout",
  };
  return map[status] ?? `HTTP ${status}`;
}

/**
 * Fetch a URL following redirects manually, re-validating each hop.
 * Throws SsrfError / HttpError / DOMException(AbortError) on failure.
 */
export async function safeFetch(
  rawUrl: string,
  opts: {
    timeoutMs?: number;
    signal?: AbortSignal;
    headers?: Record<string, string>;
  } = {}
): Promise<SafeResponse> {
  const timeoutMs = opts.timeoutMs ?? config.requestTimeoutMs;
  let current = await validateUrl(rawUrl);
  const chain: string[] = [current];

  for (let hop = 0; hop <= config.maxRedirects; hop++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("Request timed out")), timeoutMs);
    // Combine caller cancellation with our timeout.
    const onCallerAbort = () => controller.abort(opts.signal?.reason ?? new Error("Cancelled"));
    if (opts.signal) {
      if (opts.signal.aborted) {
        clearTimeout(timer);
        throw opts.signal.reason ?? new Error("Cancelled");
      }
      opts.signal.addEventListener("abort", onCallerAbort, { once: true });
    }

    let res: Response;
    try {
      res = await fetch(current, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "User-Agent": "BatchZipDownloader/1.0 (+bulk file downloader)",
          Accept: "*/*",
          ...opts.headers,
        },
      });
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onCallerAbort);
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      await res.body?.cancel().catch(() => {});
      if (!location) throw new HttpError(res.status, "Redirect without a Location header");
      if (hop === config.maxRedirects) {
        throw new HttpError(res.status, `Too many redirects (limit ${config.maxRedirects})`);
      }
      let next: string;
      try {
        next = new URL(location, current).toString();
      } catch {
        throw new HttpError(res.status, "Redirect to a malformed URL");
      }
      // Re-validate the redirect destination (SSRF / DNS rebinding guard).
      try {
        current = await validateUrl(next);
      } catch (e) {
        if (e instanceof SsrfError) {
          throw new HttpError(res.status, `Blocked redirect to unsafe destination: ${e.message}`);
        }
        throw e;
      }
      chain.push(current);
      continue;
    }

    return { finalUrl: current, status: res.status, headers: res.headers, body: res.body, redirectChain: chain };
  }

  throw new HttpError(310, `Too many redirects (limit ${config.maxRedirects})`);
}

/** Best-effort HEAD probe used by the Validate endpoint (short timeout). */
export async function safeHead(rawUrl: string, timeoutMs = 10_000): Promise<Headers | null> {
  try {
    const current = await validateUrl(rawUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(current, {
        method: "HEAD",
        redirect: "follow",
        signal: controller.signal,
        headers: { "User-Agent": "BatchZipDownloader/1.0 (+bulk file downloader)" },
      });
      // Some servers reject HEAD; treat non-2xx as "no info" rather than failure.
      if (res.status >= 200 && res.status < 300) return res.headers;
      await res.body?.cancel().catch(() => {});
      return null;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}
