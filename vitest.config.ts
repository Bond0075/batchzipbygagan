import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 30_000,
    env: {
      SSRF_TEST_ALLOW_LOCALHOST: "true",
      MAX_FILE_SIZE_BYTES: String(10 * 1024 * 1024),
      MAX_BATCH_BYTES: String(100 * 1024 * 1024),
      REQUEST_TIMEOUT_MS: "15000",
      RETRY_COUNT: "3",
      RETRY_BASE_DELAY_MS: "50",
      MAX_REDIRECTS: "5",
      MAX_CONCURRENT_JOBS: "4",
      BATCH_RETENTION_HOURS: "1",
      CLEANUP_INTERVAL_MIN: "60",
    },
    setupFiles: ["./tests/setup.ts"],
  },
});
