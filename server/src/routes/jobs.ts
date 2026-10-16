/**
 * REST API for BatchZip Downloader.
 *
 * POST /api/validate            — validate URLs (syntax, SSRF, extension hints)
 * POST /api/jobs                — create a job (checks batch-name collisions)
 * POST /api/jobs/:id/start      — start processing (requires job token)
 * GET  /api/jobs/:id            — job status + per-file table
 * GET  /api/jobs/:id/events     — server-sent events for live progress
 * POST /api/jobs/:id/cancel     — cancel a running job (requires token)
 * GET  /api/jobs/:id/zip        — download the ZIP (requires token)
 * GET  /api/jobs/:id/report     — download the failure report CSV (requires token)
 * GET  /api/jobs/:id/files/:pos — download one packaged file (requires token)
 * GET  /api/config              — public operational limits for the UI
 * GET  /api/health              — liveness
 */
import { Router, Request, Response } from "express";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import * as path from "node:path";
import { config } from "../config.js";
import {
  loadJob,
  saveJob,
  findLiveJobByBatchName,
  batchFilesDir,
  zipPath,
} from "../store.js";
import { createJob, startJob, cancelActiveJob, activeJobCount } from "../engine/jobRunner.js";
import { validateUrl, SsrfError, classifyScheme } from "../security/ssrf.js";
import { safeHead } from "../engine/http.js";
import {
  extensionFromContentDisposition,
  extensionFromUrlPath,
  determineExtension,
} from "../utils/extension.js";
import { buildFullReportCsv, sortNumerically } from "../engine/zipper.js";
import { summarize, type ValidationIssue } from "../types.js";

export const router = Router();

function jobIdOf(req: Request): string {
  return String((req.params as Record<string, string>).id);
}

function parseUrlList(body: any): string[] {
  const raw = body?.urls;
  if (!Array.isArray(raw)) throw new Error('Body must include "urls": string[]');
  return raw.map((u) => String(u ?? "").trim()).filter((u) => u.length > 0);
}

function checkToken(req: Request, job: { token: string }): boolean {
  const provided = (req.query.token as string) || (req.body?.token as string) || req.header("x-job-token");
  return typeof provided === "string" && provided.length > 0 && provided === job.token;
}

// ---------- Validation ----------

router.post("/validate", async (req: Request, res: Response) => {
  try {
    const urls = parseUrlList(req.body);
    if (urls.length === 0) {
      res.status(400).json({ error: "No URLs provided" });
      return;
    }
    if (urls.length > config.maxUrlsPerBatch) {
      res.status(400).json({
        error: `Too many URLs: ${urls.length} (limit ${config.maxUrlsPerBatch})`,
      });
      return;
    }

    const issues: ValidationIssue[] = [];
    // Validate sequentially-ish but bounded: validation probes are cheap and
    // independent (this is NOT the download engine — order is preserved by position).
    for (let i = 0; i < urls.length; i++) {
      issues.push(await validateOne(urls[i], i + 1));
    }

    const invalid = issues.filter((x) => !x.valid).length;
    const warnings = issues.filter((x) => x.valid && x.extensionWarning).length;
    res.json({ total: urls.length, invalid, warnings, issues });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

async function validateOne(raw: string, position: number): Promise<ValidationIssue> {
  const problems: string[] = [];
  const scheme = classifyScheme(raw);
  if (!scheme.ok) {
    problems.push(scheme.reason!);
    return { position, url: raw, valid: false, problems, extension: null, extensionSource: null, extensionWarning: null };
  }

  let normalized: string;
  try {
    normalized = await validateUrl(raw);
  } catch (e) {
    const msg = e instanceof SsrfError ? e.message : "URL rejected";
    problems.push(msg);
    return { position, url: raw, valid: false, problems, extension: null, extensionSource: null, extensionWarning: null };
  }

  // Best-effort HEAD probe for Content-Disposition / Content-Length hints.
  let extension: string | null = null;
  let extensionSource: ValidationIssue["extensionSource"] = null;
  let extensionWarning: string | null = null;
  try {
    const url = new URL(normalized);
    const fromPath = extensionFromUrlPath(url);
    if (fromPath) {
      extension = fromPath;
      extensionSource = "url-path";
    } else {
      const headers = await safeHead(normalized);
      if (headers) {
        const fromCd = extensionFromContentDisposition(headers.get("content-disposition"));
        if (fromCd) {
          extension = fromCd;
          extensionSource = "content-disposition";
        }
      }
    }
  } catch {
    /* best effort only */
  }

  if (!extension) {
    const d = determineExtension({ contentDisposition: null, url: new URL(normalized) });
    extensionWarning = d.warning;
  }

  return { position, url: raw, valid: true, problems, extension, extensionSource, extensionWarning };
}

// ---------- Job creation ----------

async function freeDiskBytes(dir: string): Promise<number | null> {
  return new Promise((resolve) => {
    execFile("df", ["-k", "--output=avail", dir], (err, stdout) => {
      if (err) return resolve(null);
      const lines = stdout.trim().split("\n");
      const kb = Number(lines[lines.length - 1]?.trim());
      resolve(Number.isFinite(kb) ? kb * 1024 : null);
    });
  });
}

router.post("/jobs", async (req: Request, res: Response) => {
  try {
    const urls = parseUrlList(req.body);
    if (urls.length === 0) {
      res.status(400).json({ error: "No URLs provided" });
      return;
    }
    if (urls.length > config.maxUrlsPerBatch) {
      res.status(400).json({
        error: `Too many URLs: ${urls.length} (limit ${config.maxUrlsPerBatch})`,
      });
      return;
    }

    const batchName = String(req.body.batchName ?? `batch-${Date.now()}`).trim() || `batch-${Date.now()}`;
    if (batchName.length > 80) {
      res.status(400).json({ error: "Batch name too long (max 80 characters)" });
      return;
    }
    if (/[\\/:*?"<>|]/.test(batchName)) {
      res.status(400).json({ error: 'Batch name contains invalid characters (\\ / : * ? " < > |)' });
      return;
    }

    // Overwrite protection: never silently reuse a live batch name.
    const existing = await findLiveJobByBatchName(batchName);
    if (existing && !req.body.forceReplace) {
      res.status(409).json({
        error: `A batch named "${existing.batchName}" already exists`,
        code: "BATCH_NAME_EXISTS",
        existingJobId: existing.id,
        suggestion: `${batchName}-${Date.now().toString(36)}`,
      });
      return;
    }

    // Pre-validate every URL (SSRF + syntax) before creating the job.
    const bad: { position: number; url: string; reason: string }[] = [];
    for (let i = 0; i < urls.length; i++) {
      try {
        await validateUrl(urls[i]);
      } catch (e) {
        bad.push({ position: i + 1, url: urls[i], reason: e instanceof Error ? e.message : String(e) });
      }
    }
    if (bad.length > 0) {
      res.status(400).json({ error: "One or more URLs are invalid or blocked", code: "URLS_REJECTED", bad });
      return;
    }

    // Disk-space guard.
    const free = await freeDiskBytes(config.dataDir);
    if (free !== null && free < config.minFreeDiskBytes) {
      res.status(507).json({ error: "Insufficient disk space on the server; try again later" });
      return;
    }

    const job = await createJob(batchName, urls);
    res.status(201).json({ job: summarize(job), token: job.token, items: job.items });
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ---------- Start / cancel ----------

router.post("/jobs/:id/start", async (req: Request, res: Response) => {
  const job = await loadJob(jobIdOf(req));
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  if (!checkToken(req, job)) {
    res.status(403).json({ error: "Invalid job token" });
    return;
  }
  if (job.phase !== "created") {
    res.status(409).json({ error: `Job cannot be started from phase "${job.phase}"` });
    return;
  }
  if (activeJobCount() >= config.maxConcurrentJobs) {
    res.status(429).json({ error: `Server is busy (max ${config.maxConcurrentJobs} concurrent jobs)` });
    return;
  }
  try {
    // Don't await the loop; the client follows progress via SSE/polling.
    startJob(job.id).catch((e) => console.error(`[job ${job.id}]`, e));
    res.json({ ok: true, phase: "downloading" });
  } catch (e) {
    res.status(409).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

router.post("/jobs/:id/cancel", async (req: Request, res: Response) => {
  const job = await loadJob(jobIdOf(req));
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  if (!checkToken(req, job)) {
    res.status(403).json({ error: "Invalid job token" });
    return;
  }
  const wasActive = cancelActiveJob(job.id);
  if (!wasActive && job.phase !== "created") {
    res.status(409).json({ error: `Nothing to cancel (phase "${job.phase}")` });
    return;
  }
  if (job.phase === "created") {
    // Never started: mark cancelled directly.
    job.phase = "cancelled";
    job.finishedAt = new Date().toISOString();
    for (const item of job.items) {
      item.status = "cancelled";
      item.error = item.error ?? "Cancelled before starting";
      item.finishedAt = item.finishedAt ?? job.finishedAt;
    }
    await saveJob(job);
  }
  res.json({ ok: true });
});

// ---------- Status & events ----------

router.get("/jobs/:id", async (req: Request, res: Response) => {
  const job = await loadJob(jobIdOf(req));
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  res.json({ job: summarize(job), items: job.items });
});

router.get("/jobs/:id/events", async (req: Request, res: Response) => {
  const job = await loadJob(jobIdOf(req));
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(`event: hello\ndata: {"jobId": ${JSON.stringify(job.id)}}\n\n`);

  let lastSent = "";
  const timer = setInterval(async () => {
    const current = await loadJob(jobIdOf(req));
    if (!current) {
      clearInterval(timer);
      res.end();
      return;
    }
    const payload = JSON.stringify({ job: summarize(current), items: current.items });
    if (payload !== lastSent) {
      lastSent = payload;
      res.write(`event: progress\ndata: ${payload}\n\n`);
    }
    if (["completed", "failed", "cancelled"].includes(current.phase)) {
      clearInterval(timer);
      res.write(`event: done\ndata: ${payload}\n\n`);
      res.end();
    }
  }, 500);

  req.on("close", () => clearInterval(timer));
});

// ---------- Downloads ----------

router.get("/jobs/:id/zip", async (req: Request, res: Response) => {
  const job = await loadJob(jobIdOf(req));
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  if (!checkToken(req, job)) {
    res.status(403).json({ error: "Invalid job token" });
    return;
  }
  if (!job.zipReady || !job.zipName) {
    res.status(409).json({ error: "ZIP is not ready yet" });
    return;
  }
  const p = zipPath(job.id, job.zipName);
  try {
    await fs.access(p);
  } catch {
    res.status(410).json({ error: "ZIP file no longer available (expired)" });
    return;
  }
  res.download(p, job.zipName);
});

router.get("/jobs/:id/report", async (req: Request, res: Response) => {
  const job = await loadJob(jobIdOf(req));
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  if (!checkToken(req, job)) {
    res.status(403).json({ error: "Invalid job token" });
    return;
  }
  const csv = buildFullReportCsv(job.items);
  res.setHeader("Content-Type", "text/csv");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="batch-report-${job.id}.csv"`
  );
  res.send(csv);
});

router.get("/jobs/:id/files/:pos", async (req: Request, res: Response) => {
  const job = await loadJob(jobIdOf(req));
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  if (!checkToken(req, job)) {
    res.status(403).json({ error: "Invalid job token" });
    return;
  }
  const pos = Number((req.params as Record<string, string>).pos);
  const item = job.items.find((i) => i.position === pos);
  if (!item || !item.filename || (item.status !== "verified" && item.status !== "packaged")) {
    res.status(404).json({ error: "File not available" });
    return;
  }
  // Containment: filename is always "<position>.<ext>" produced server-side.
  if (!/^\d+\.[a-z0-9]{1,10}$/.test(item.filename)) {
    res.status(400).json({ error: "Invalid filename record" });
    return;
  }
  const p = path.join(batchFilesDir(job.id), item.filename);
  try {
    await fs.access(p);
  } catch {
    res.status(410).json({ error: "File no longer available (expired)" });
    return;
  }
  res.download(p, item.filename);
});

// ---------- Config & health ----------

router.get("/config", (_req: Request, res: Response) => {
  res.json({
    maxUrlsPerBatch: config.maxUrlsPerBatch,
    maxFileSizeBytes: config.maxFileSizeBytes,
    maxBatchBytes: config.maxBatchBytes,
    requestTimeoutMs: config.requestTimeoutMs,
    retryCount: config.retryCount,
    batchRetentionHours: config.batchRetentionHours,
    maxConcurrentJobs: config.maxConcurrentJobs,
  });
});

router.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true, activeJobs: activeJobCount(), time: new Date().toISOString() });
});

export { sortNumerically };
