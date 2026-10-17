// Runs before each test FILE's imports: give every vitest worker its own
// data directory so parallel test files can never delete each other's data.
import { promises as fs } from "node:fs";
import { beforeEach } from "vitest";

process.env.DATA_DIR =
  "./test-data-worker-" + (process.env.VITEST_WORKER_ID ?? "0");

beforeEach(async () => {
  await fs.rm(process.env.DATA_DIR!, { recursive: true, force: true });
});
