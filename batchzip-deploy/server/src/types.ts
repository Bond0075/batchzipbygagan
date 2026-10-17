/**
 * Shared domain types for BatchZip Downloader.
 */

export type FileStatus =
  | "pending"
  | "downloading"
  | "retrying"
  | "verified"
  | "failed"
  | "cancelled"
  | "packaged";

export type JobPhase =
  | "created"
  | "downloading"
  | "packaging"
  | "merging"
  | "completed"
  | "failed"
  | "cancelled";

export interface FileItem {
  position: number; // immutable, 1-based, matches original pasted URL order
  url: string;
  status: FileStatus;
  attempts: number; // total attempts made so far
  retries: number; // attempts - 1 (i.e. number of retries)
  bytes: number; // bytes written to disk for the accepted download
  expectedBytes: number | null; // trustworthy Content-Length, if any
  filename: string | null; // e.g. "3.pdf" once known
  extension: string | null; // e.g. "pdf" once determined
  extensionSource: "content-disposition" | "url-path" | "content-sniff" | "unknown" | null;
  extensionWarning: string | null; // set when the extension could not be established reliably
  error: string | null; // human-readable reason for the last failure
  errorHistory: { attempt: number; error: string; at: string }[];
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  bytesPerSecond: number | null;
}

export interface Job {
  id: string;
  batchName: string; // user-visible batch name, unique among live batches
  token: string; // per-job access token required for sensitive operations
  createdAt: string;
  updatedAt: string;
  expiresAt: string; // retention deadline for automatic cleanup
  phase: JobPhase;
  total: number;
  done: number; // positions that reached a terminal file status
  succeeded: number;
  failed: number;
  cancelledCount: number;
  totalBytes: number;
  startedAt: string | null;
  finishedAt: string | null;
  elapsedMs: number | null;
  bytesPerSecond: number | null;
  currentPosition: number | null;
  zipName: string | null; // e.g. "batch-1-28.zip"
  zipBytes: number | null;
  zipReady: boolean;
  // Audio-merge mode: concatenate verified audio files (position order) into one file.
  mergeAudio: boolean;
  mergeFormat: "mp3" | "wav";
  mergedName: string | null; // e.g. "batch-1-28-merged.mp3"
  mergedBytes: number | null;
  mergedReady: boolean;
  mergeError: string | null; // set when merging was requested but failed
  error: string | null; // job-level error (e.g. zip generation failed)
  items: FileItem[];
}

export interface JobSummary {
  id: string;
  batchName: string;
  phase: JobPhase;
  total: number;
  done: number;
  succeeded: number;
  failed: number;
  cancelledCount: number;
  totalBytes: number;
  startedAt: string | null;
  finishedAt: string | null;
  elapsedMs: number | null;
  bytesPerSecond: number | null;
  currentPosition: number | null;
  zipName: string | null;
  zipBytes: number | null;
  zipReady: boolean;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export function summarize(job: Job): JobSummary {
  const {
    items,
    token: _token,
    ...rest
  } = job;
  void _token;
  return rest;
}

export interface ValidationIssue {
  position: number;
  url: string;
  valid: boolean;
  problems: string[];
  extension: string | null;
  extensionSource: FileItem["extensionSource"];
  extensionWarning: string | null;
}

export function newFileItem(position: number, url: string): FileItem {
  return {
    position,
    url,
    status: "pending",
    attempts: 0,
    retries: 0,
    bytes: 0,
    expectedBytes: null,
    filename: null,
    extension: null,
    extensionSource: null,
    extensionWarning: null,
    error: null,
    errorHistory: [],
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    bytesPerSecond: null,
  };
}
