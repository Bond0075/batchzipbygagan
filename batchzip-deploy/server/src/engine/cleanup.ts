/**
 * Automatic cleanup of expired jobs, their batch directories, temp files and
 * orphaned batch directories (no matching job record).
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { config } from "../config.js";
import { listJobs, deleteJobData, batchDir } from "../store.js";

export interface CleanupReport {
  expiredJobs: number;
  orphanDirs: number;
  tmpFiles: number;
  errors: string[];
}

export async function runCleanup(): Promise<CleanupReport> {
  const report: CleanupReport = { expiredJobs: 0, orphanDirs: 0, tmpFiles: 0, errors: [] };
  const now = Date.now();

  const jobs = await listJobs().catch((e) => {
    report.errors.push(`listJobs: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  });

  for (const job of jobs) {
    if (new Date(job.expiresAt).getTime() <= now) {
      try {
        await deleteJobData(job.id);
        report.expiredJobs++;
      } catch (e) {
        report.errors.push(`delete ${job.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  // Orphaned batch dirs (job record gone but files remain).
  const batchesRoot = path.join(config.dataDir, "batches");
  try {
    const dirs = await fs.readdir(batchesRoot);
    const liveIds = new Set((await listJobs()).map((j) => j.id));
    for (const d of dirs) {
      if (!liveIds.has(d)) {
        try {
          await fs.rm(path.join(batchesRoot, d), { recursive: true, force: true });
          report.orphanDirs++;
        } catch (e) {
          report.errors.push(`orphan ${d}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
  } catch (e: any) {
    if (e?.code !== "ENOENT") report.errors.push(`batches scan: ${e.message}`);
  }

  // Stale temp files (>2h old).
  const tmpRoot = path.join(config.dataDir, "tmp");
  try {
    const entries = await fs.readdir(tmpRoot);
    for (const name of entries) {
      const p = path.join(tmpRoot, name);
      try {
        const st = await fs.stat(p);
        const ageMs = now - st.mtimeMs;
        if (ageMs > 2 * 3600_000) {
          await fs.rm(p, { recursive: true, force: true });
          report.tmpFiles++;
        }
      } catch {
        /* ignore */
      }
    }
  } catch (e: any) {
    if (e?.code !== "ENOENT") report.errors.push(`tmp scan: ${e.message}`);
  }

  void batchDir;
  return report;
}

export function startCleanupScheduler(): NodeJS.Timeout {
  const intervalMs = config.cleanupIntervalMin * 60_000;
  // Run once shortly after boot, then on the interval.
  setTimeout(() => {
    runCleanup().catch((e) => console.error("[cleanup]", e));
  }, 30_000);
  return setInterval(() => {
    runCleanup().catch((e) => console.error("[cleanup]", e));
  }, intervalMs);
}
