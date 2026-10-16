/**
 * Job runner — the strictly sequential download engine.
 *
 * MANDATORY INVARIANT: URLs are processed with a plain `for` loop and `await`.
 * No Promise.all, no worker pools, no concurrent queues — position N+1 never
 * starts until position N has reached a terminal status (verified/failed/
 * cancelled). A failure at position 7 never skips position 8, and positions
 * are never renumbered.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { config } from "../config.js";
import { saveJob, loadJob, listJobs, batchFilesDir, tmpPath } from "../store.js";
import { downloadOne, formatBytes } from "./downloader.js";
import { createZip } from "./zipper.js";
import type { Job, FileItem, JobPhase, FileStatus } from "../types.js";
import { newFileItem } from "../types.js";

interface ActiveJob {
  cancel: () => void;
  promise: Promise<void>;
}

const active = new Map<string, ActiveJob>();

export function isJobActive(jobId: string): boolean {
  return active.has(jobId);
}

export function activeJobCount(): number {
  return active.size;
}

export function cancelActiveJob(jobId: string): boolean {
  const a = active.get(jobId);
  if (!a) return false;
  a.cancel();
  return true;
}

export async function recoverInterruptedJobs(): Promise<number> {
  // Jobs left in a non-terminal phase after a restart can never be resumed
  // safely (we don't claim resumable downloads), so mark them cancelled.
  const jobs = await listJobs();
  let n = 0;
  for (const job of jobs) {
    if (job.phase === "downloading" || job.phase === "packaging") {
      job.phase = "cancelled";
      job.error = "Server restarted during processing; job was safely cancelled";
      job.finishedAt = new Date().toISOString();
      for (const item of job.items) {
        if (!isTerminal(item.status)) {
          item.status = "cancelled";
          item.finishedAt = item.finishedAt ?? new Date().toISOString();
        }
      }
      recomputeCounts(job);
      await saveJob(job);
      n++;
    }
  }
  return n;
}

function isTerminal(s: FileStatus): boolean {
  return s === "verified" || s === "failed" || s === "cancelled" || s === "packaged";
}

function recomputeCounts(job: Job): void {
  job.done = job.items.filter((i) => isTerminal(i.status)).length;
  job.succeeded = job.items.filter((i) => i.status === "verified" || i.status === "packaged").length;
  job.failed = job.items.filter((i) => i.status === "failed").length;
  job.cancelledCount = job.items.filter((i) => i.status === "cancelled").length;
  job.totalBytes = job.items.reduce((a, i) => a + (i.bytes || 0), 0);
}

/** Create a job record (does NOT start processing). */
export async function createJob(batchName: string, urls: string[]): Promise<Job> {
  const id = randomBytes(12).toString("hex");
  const total = urls.length;
  const now = new Date().toISOString();
  const job: Job = {
    id,
    batchName: batchName.trim(),
    token: randomBytes(config.jobTokenBytes).toString("hex"),
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(Date.now() + config.batchRetentionHours * 3600_000).toISOString(),
    phase: "created",
    total,
    done: 0,
    succeeded: 0,
    failed: 0,
    cancelledCount: 0,
    totalBytes: 0,
    startedAt: null,
    finishedAt: null,
    elapsedMs: null,
    bytesPerSecond: null,
    currentPosition: null,
    zipName: `batch-1-${total}.zip`,
    zipBytes: null,
    zipReady: false,
    error: null,
    items: urls.map((url, i) => newFileItem(i + 1, url)),
  };
  await fs.mkdir(batchFilesDir(id), { recursive: true });
  await saveJob(job);
  return job;
}

/** Start processing a created job. Throws if a job is already running or limits hit. */
export function startJob(jobId: string): Promise<void> {
  if (active.has(jobId)) throw new Error("Job is already running");
  if (active.size >= config.maxConcurrentJobs) {
    throw new Error(
      `Too many concurrent jobs (limit ${config.maxConcurrentJobs}); try again shortly`
    );
  }

  let cancelFn!: () => void;
  const promise = runJobLoop(jobId, (fn) => {
    cancelFn = fn;
  }).finally(() => {
    active.delete(jobId);
  });

  active.set(jobId, {
    cancel: () => cancelFn(),
    promise,
  });
  return promise;
}

/**
 * The sequential engine. Reads items in exact input order; each iteration
 * fully completes (verified/failed/cancelled) before the next begins.
 */
async function runJobLoop(
  jobId: string,
  registerCancel: (fn: () => void) => void
): Promise<void> {
  const job = await loadJob(jobId);
  if (!job) throw new Error("Job not found");

  let cancelled = false;
  let attemptController: AbortController | null = null;
  registerCancel(() => {
    cancelled = true;
    attemptController?.abort(new Error("Cancelled by user"));
  });

  const tmpDir = await tmpPath(`job-${jobId}`);
  await fs.mkdir(tmpDir, { recursive: true });

  job.phase = "downloading";
  job.startedAt = new Date().toISOString();
  const jobStart = Date.now();
  await saveJob(job);

  const filesDir = batchFilesDir(jobId);

  try {
    // === STRICTLY SEQUENTIAL LOOP ===
    for (const item of job.items) {
      if (cancelled) {
        markRemainingCancelled(job, item.position);
        break;
      }

      job.currentPosition = item.position;
      item.status = "downloading";
      item.startedAt = new Date().toISOString();
      await saveJob(job);

      attemptController = new AbortController();
      const attemptStart = Date.now();
      let lastBytes = 0;

      const result = await downloadOne(item.url, item.position, tmpDir, config.maxFileSizeBytes, {
        signal: attemptController.signal,
        shouldCancel: () => cancelled,
        onAttemptStart: (attempt) => {
          item.attempts = attempt;
          item.retries = attempt - 1;
          if (attempt > 1) item.status = "retrying";
          // Fire-and-forget progress persistence (never blocks the download).
          saveJob(job).catch(() => {});
        },
        onProgress: (bytes) => {
          lastBytes = bytes;
          // Throttle: the SSE layer polls job state; no need to spam disk.
        },
      });
      void lastBytes;

      item.attempts = result.attempts;
      item.retries = Math.max(0, result.attempts - 1);
      item.errorHistory = result.errorHistory;
      item.finishedAt = new Date().toISOString();
      item.durationMs = Date.now() - attemptStart;
      item.bytesPerSecond =
        item.durationMs > 0 ? Math.round((result.bytes / item.durationMs) * 1000) : null;

      if (cancelled && !result.ok) {
        // The runner's own cancellation flag wins over however the aborted
        // fetch classified itself — stop here, keep completed work intact.
        item.status = "cancelled";
        item.error = "Cancelled by user";
        markRemainingCancelled(job, item.position + 1);
        await saveJob(job);
        break;
      }

      if (result.ok && result.tempPath && result.extension) {
        const filename = `${item.position}.${result.extension}`;
        const dest = path.join(filesDir, filename);
        await fs.rename(result.tempPath, dest);
        item.status = "verified";
        item.filename = filename;
        item.extension = result.extension;
        item.extensionSource = result.extensionSource;
        item.extensionWarning = result.extensionWarning;
        item.bytes = result.bytes;
        item.expectedBytes = result.expectedBytes;
        item.error = null;

        // Enforce the total batch byte cap as we go.
        const totalBytes = job.items.reduce((a, i) => a + (i.bytes || 0), 0);
        if (totalBytes > config.maxBatchBytes) {
          await fs.rm(dest, { force: true }).catch(() => {});
          item.status = "failed";
          item.filename = null;
          item.bytes = 0;
          item.error = `Batch exceeded the total size limit of ${formatBytes(config.maxBatchBytes)}`;
          item.errorHistory.push({
            attempt: result.attempts,
            error: item.error,
            at: new Date().toISOString(),
          });
        }
      } else if (result.ok && result.tempPath && !result.extension) {
        // Verified bytes, but no reliable extension — per policy this must
        // not be silently packaged. Keep the file, mark failed with guidance.
        await fs.rm(result.tempPath, { force: true }).catch(() => {});
        item.status = "failed";
        item.error =
          result.extensionWarning ??
          "Could not determine a reliable file extension; file was not packaged";
        item.errorHistory.push({
          attempt: result.attempts,
          error: item.error,
          at: new Date().toISOString(),
        });
      } else {
        item.status = cancelled ? "cancelled" : "failed";
        item.error = result.error ?? "Unknown error";
      }

      recomputeCounts(job);
      await saveJob(job);
      // Loop continues to the NEXT position only after this one is terminal.
    }

    if (cancelled) {
      job.phase = "cancelled";
      job.finishedAt = new Date().toISOString();
      job.elapsedMs = Date.now() - jobStart;
      await saveJob(job);
      return;
    }

    // === Packaging ===
    job.phase = "packaging";
    job.currentPosition = null;
    await saveJob(job);

    if (job.succeeded > 0) {
      const zipResult = await createZip({
        jobId: job.id,
        zipName: job.zipName!,
        items: job.items,
      });
      job.zipBytes = zipResult.bytes;
      job.zipReady = true;
      for (const item of job.items) {
        if (item.status === "verified") item.status = "packaged";
      }
    } else {
      job.zipReady = false;
    }

    job.phase = job.failed > 0 && job.succeeded === 0 ? "failed" : "completed";
    if (job.phase === "failed" && !job.error) {
      job.error = "All downloads failed; no ZIP was generated";
    }
    job.finishedAt = new Date().toISOString();
    job.elapsedMs = Date.now() - jobStart;
    job.bytesPerSecond =
      job.elapsedMs > 0 ? Math.round((job.totalBytes / job.elapsedMs) * 1000) : null;
    recomputeCounts(job);
    await saveJob(job);
  } catch (err) {
    job.phase = "failed";
    job.error = err instanceof Error ? err.message : String(err);
    job.finishedAt = new Date().toISOString();
    job.elapsedMs = Date.now() - jobStart;
    for (const item of job.items) {
      if (!isTerminal(item.status)) {
        item.status = "cancelled";
        item.finishedAt = item.finishedAt ?? new Date().toISOString();
      }
    }
    recomputeCounts(job);
    await saveJob(job);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

function markRemainingCancelled(job: Job, fromPosition: number): void {
  const now = new Date().toISOString();
  for (const item of job.items) {
    if (item.position >= fromPosition && !isTerminal(item.status)) {
      item.status = "cancelled";
      item.error = item.error ?? "Cancelled before starting";
      item.finishedAt = item.finishedAt ?? now;
    }
  }
  recomputeCounts(job);
}

export function getJobPhase(jobId: string): Promise<JobPhase | null> {
  return loadJob(jobId).then((j) => j?.phase ?? null);
}
