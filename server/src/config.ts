/**
 * BatchZip Downloader — server configuration.
 * Every limit is driven by environment variables so operators can tune
 * without touching code. Conservative defaults are used; see .env.example
 * and README for guidance on raising them safely.
 */

function num(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return def;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < 0) {
    throw new Error(`Invalid ${name}=${raw}: must be a non-negative number`);
  }
  return v;
}

function bool(name: string, def: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return def;
  return raw.toLowerCase() === "true" || raw === "1";
}

export const config = {
  port: num("PORT", 3001),
  dataDir: process.env.DATA_DIR || "./data",

  // ---- Batch limits (conservative defaults) ----
  maxUrlsPerBatch: num("MAX_URLS_PER_BATCH", 50),
  maxFileSizeBytes: num("MAX_FILE_SIZE_BYTES", 512 * 1024 * 1024), // 512 MiB
  maxBatchBytes: num("MAX_BATCH_BYTES", 5 * 1024 * 1024 * 1024), // 5 GiB
  requestTimeoutMs: num("REQUEST_TIMEOUT_MS", 60_000),
  retryCount: num("RETRY_COUNT", 3), // retries AFTER the initial attempt (default 3)
  retryBaseDelayMs: num("RETRY_BASE_DELAY_MS", 1_000),
  maxRedirects: num("MAX_REDIRECTS", 5),

  // ---- Job management ----
  maxConcurrentJobs: num("MAX_CONCURRENT_JOBS", 4), // across users; within a batch downloads are ALWAYS sequential
  batchRetentionHours: num("BATCH_RETENTION_HOURS", 24),
  cleanupIntervalMin: num("CLEANUP_INTERVAL_MIN", 30),
  minFreeDiskBytes: num("MIN_FREE_DISK_BYTES", 1 * 1024 * 1024 * 1024), // refuse new jobs below 1 GiB free

  // ---- Security ----
  // When true, tests may fetch from loopback fixtures via an explicit allowlist.
  // NEVER enable in production.
  ssrfTestAllowLocalhost: bool("SSRF_TEST_ALLOW_LOCALHOST", false),
  // Comma-separated exact hostnames that bypass private-IP blocking (still
  // requires http/https and passes redirect re-validation). Empty by default.
  ssrfAllowlistHosts: (process.env.SSRF_ALLOWLIST_HOSTS || "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean),

  rateLimitWindowMs: num("RATE_LIMIT_WINDOW_MS", 60_000),
  rateLimitMax: num("RATE_LIMIT_MAX", 60), // requests per window per IP

  jobTokenBytes: num("JOB_TOKEN_BYTES", 24),
};

export type Config = typeof config;
