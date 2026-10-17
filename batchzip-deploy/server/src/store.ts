/**
 * Job persistence.
 *
 * Jobs are stored as JSON files under <dataDir>/jobs/<jobId>.json and batch
 * files under <dataDir>/batches/<jobId>/. This gives us crash-resilient state
 * without requiring an external database; every mutation is written through
 * immediately so a restart can recover job status (see recovery in engine).
 *
 * If you outgrow this (multi-node deployments), replace this module with a
 * database-backed implementation behind the same interface.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { config } from "./config.js";
import type { Job } from "./types.js";

export function jobsDir(): string {
  return path.join(config.dataDir, "jobs");
}

export function batchDir(jobId: string): string {
  return path.join(config.dataDir, "batches", jobId);
}

export function batchFilesDir(jobId: string): string {
  return path.join(batchDir(jobId), "files");
}

export function zipPath(jobId: string, zipName: string): string {
  return path.join(batchDir(jobId), zipName);
}

function jobFile(jobId: string): string {
  return path.join(jobsDir(), `${jobId}.json`);
}

export async function initStore(): Promise<void> {
  await fs.mkdir(jobsDir(), { recursive: true });
  await fs.mkdir(path.join(config.dataDir, "batches"), { recursive: true });
  await fs.mkdir(path.join(config.dataDir, "tmp"), { recursive: true });
}

export async function saveJob(job: Job): Promise<void> {
  job.updatedAt = new Date().toISOString();
  await fs.mkdir(jobsDir(), { recursive: true });
  const tmp = jobFile(job.id) + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(job, null, 2), "utf8");
  await fs.rename(tmp, jobFile(job.id)); // atomic replace
}

export async function loadJob(jobId: string): Promise<Job | null> {
  try {
    const raw = await fs.readFile(jobFile(jobId), "utf8");
    return JSON.parse(raw) as Job;
  } catch (err: any) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

export async function listJobs(): Promise<Job[]> {
  let names: string[];
  try {
    names = await fs.readdir(jobsDir());
  } catch {
    return [];
  }
  const jobs: Job[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const job = await loadJob(name.slice(0, -5));
    if (job) jobs.push(job);
  }
  return jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Find a live (not yet expired) job using a given batch display name. */
export async function findLiveJobByBatchName(batchName: string): Promise<Job | null> {
  const jobs = await listJobs();
  const now = Date.now();
  const needle = batchName.trim().toLowerCase();
  for (const job of jobs) {
    if (job.batchName.trim().toLowerCase() === needle && new Date(job.expiresAt).getTime() > now) {
      return job;
    }
  }
  return null;
}

export async function deleteJobData(jobId: string): Promise<void> {
  await fs.rm(batchDir(jobId), { recursive: true, force: true });
  await fs.rm(jobFile(jobId), { force: true });
}

export async function tmpPath(name: string): Promise<string> {
  return path.join(config.dataDir, "tmp", name);
}
