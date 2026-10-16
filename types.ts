// Types mirror /home/hatch/workspace/batchzip/API_CONTRACT.md exactly.

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
  | "completed"
  | "failed"
  | "cancelled";

export type ExtensionSource =
  | "content-disposition"
  | "url-path"
  | "content-sniff"
  | "unknown";

export interface ErrorAttempt {
  attempt: number;
  error: string;
  at: string; // ISO timestamp
}

export interface FileItem {
  position: number;
  url: string;
  status: FileStatus;
  attempts: number;
  retries: number;
  bytes: number;
  expectedBytes: number | null;
  filename: string | null;
  extension: string | null;
  extensionSource: ExtensionSource | null;
  extensionWarning: string | null;
  error: string | null;
  errorHistory: ErrorAttempt[];
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  bytesPerSecond: number | null;
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

export interface ValidationIssue {
  position: number;
  url: string;
  valid: boolean;
  problems: string[];
  extension: string | null;
  extensionSource: ExtensionSource | null;
  extensionWarning: string | null;
}

export interface ValidationResult {
  total: number;
  invalid: number;
  warnings: number;
  issues: ValidationIssue[];
}

export interface UrlRejection {
  position: number;
  url: string;
  reason: string;
}

export interface ServerConfig {
  maxUrlsPerBatch: number;
  maxFileSizeBytes: number;
  maxBatchBytes: number;
  requestTimeoutMs: number;
  retryCount: number;
  batchRetentionHours: number;
  maxConcurrentJobs: number;
}

export interface JobPayload {
  job: JobSummary;
  items: FileItem[];
}

export const TERMINAL_PHASES: JobPhase[] = ["completed", "failed", "cancelled"];
export const RUNNING_PHASES: JobPhase[] = ["created", "downloading", "packaging"];

export function isTerminalPhase(phase: JobPhase): boolean {
  return TERMINAL_PHASES.includes(phase);
}

export function isRunningPhase(phase: JobPhase): boolean {
  return RUNNING_PHASES.includes(phase);
}
