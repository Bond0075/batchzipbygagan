/**
 * Cancellation, batch-name overwrite protection, and cleanup tests.
 */
import { describe, it, expect } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { config } from "../src/config.js";
import { startFixtureServer } from "./fixtures.js";
import { createJob, startJob, cancelActiveJob } from "../src/engine/jobRunner.js";
import { loadJob, findLiveJobByBatchName } from "../src/store.js";
import { runCleanup } from "../src/engine/cleanup.js";

describe("cancellation", () => {
  it("stops safely: keeps completed work, marks the rest cancelled", async () => {
    const fx = await startFixtureServer();
    try {
      const urls = Array.from({ length: 5 }, () => `${fx.base}/slow`); // 800ms each
      const job = await createJob("cancel-test", urls);

      const running = startJob(job.id);
      // Let the first file finish (~800ms) and the second get underway.
      await new Promise((r) => setTimeout(r, 1300));
      expect(cancelActiveJob(job.id)).toBe(true);
      await running;

      const finished = (await loadJob(job.id))!;
      expect(finished.phase).toBe("cancelled");
      expect(finished.items[0].status).toBe("verified"); // completed work preserved
      // The in-flight and all remaining positions are cancelled, never started after cancel.
      for (let i = 1; i < 5; i++) {
        expect(finished.items[i].status).toBe("cancelled");
      }
      expect(finished.zipReady).toBe(false); // no ZIP generated for a cancelled job
    } finally {
      await fx.close();
    }
  });

  it("cancelActiveJob returns false for unknown jobs", () => {
    expect(cancelActiveJob("does-not-exist")).toBe(false);
  });
});

describe("batch overwrite protection", () => {
  it("detects an existing live batch name", async () => {
    const fx = await startFixtureServer();
    try {
      const job = await createJob("my-batch", [`${fx.base}/files/1.wav`]);
      const found = await findLiveJobByBatchName("my-batch");
      expect(found?.id).toBe(job.id);
      // Case-insensitive match.
      expect(await findLiveJobByBatchName("MY-BATCH")).not.toBeNull();
      // Unknown name → null.
      expect(await findLiveJobByBatchName("other-batch")).toBeNull();
    } finally {
      await fx.close();
    }
  });
});

describe("cleanup", () => {
  it("removes expired jobs, orphan dirs and stale tmp files", async () => {
    const fx = await startFixtureServer();
    try {
      const job = await createJob("cleanup-test", [`${fx.base}/files/1.wav`]);
      await startJob(job.id);

      // Expire the job manually.
      const expired = (await loadJob(job.id))!;
      expired.expiresAt = new Date(Date.now() - 1000).toISOString();
      const { saveJob } = await import("../src/store.js");
      await saveJob(expired);

      // Orphan batch dir (no job record).
      const orphanDir = path.join(config.dataDir, "batches", "orphan-123");
      await fs.mkdir(orphanDir, { recursive: true });
      await fs.writeFile(path.join(orphanDir, "junk"), "x");

      // Stale tmp file (>2h old).
      const tmpRoot = path.join(config.dataDir, "tmp");
      await fs.mkdir(tmpRoot, { recursive: true });
      const stale = path.join(tmpRoot, "stale.part");
      await fs.writeFile(stale, "x");
      const twoHoursAgo = new Date(Date.now() - 3 * 3600_000);
      await fs.utimes(stale, twoHoursAgo, twoHoursAgo);

      const report = await runCleanup();
      expect(report.expiredJobs).toBe(1);
      expect(report.orphanDirs).toBe(1);
      expect(report.tmpFiles).toBe(1);
      expect(await loadJob(job.id)).toBeNull();
      await expect(fs.access(orphanDir)).rejects.toThrow();
      await expect(fs.access(stale)).rejects.toThrow();
    } finally {
      await fx.close();
    }
  });
});
