import type {
  FileItem,
  JobSummary,
  ServerConfig,
  UrlRejection,
  ValidationResult,
} from "./types";

/** Error thrown for failed API calls. Never carries secrets. */
export class ApiError extends Error {
  status: number;
  code?: string;
  suggestion?: string;
  bad?: UrlRejection[];

  constructor(
    message: string,
    opts: { status: number; code?: string; suggestion?: string; bad?: UrlRejection[] },
  ) {
    super(message);
    this.name = "ApiError";
    this.status = opts.status;
    this.code = opts.code;
    this.suggestion = opts.suggestion;
    this.bad = opts.bad;
  }
}

interface ErrorBody {
  error?: string;
  message?: string;
  code?: string;
  suggestion?: string;
  bad?: UrlRejection[];
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      headers: { "Content-Type": "application/json" },
      ...init,
    });
  } catch {
    throw new ApiError(
      "Could not reach the server. Check your connection and make sure the backend is running.",
      { status: 0 },
    );
  }

  const text = await res.text();
  let body: ErrorBody | null = null;
  if (text) {
    try {
      body = JSON.parse(text) as ErrorBody;
    } catch {
      body = null;
    }
  }

  if (!res.ok) {
    const message =
      body?.error || body?.message || `Request failed (HTTP ${res.status})`;
    throw new ApiError(message, {
      status: res.status,
      code: body?.code,
      suggestion: body?.suggestion,
      bad: body?.bad,
    });
  }
  return (body ?? {}) as T;
}

export function getConfig(): Promise<ServerConfig> {
  return request<ServerConfig>("/api/config");
}

export function validateUrls(urls: string[]): Promise<ValidationResult> {
  return request<ValidationResult>("/api/validate", {
    method: "POST",
    body: JSON.stringify({ urls }),
  });
}

interface CreateJobResponse {
  job: JobSummary;
  token: string;
  items: FileItem[];
}

export function createJob(
  urls: string[],
  batchName: string,
  forceReplace = false,
  opts: { mergeAudio?: boolean; mergeFormat?: "mp3" | "wav" } = {},
): Promise<CreateJobResponse> {
  return request<CreateJobResponse>("/api/jobs", {
    method: "POST",
    body: JSON.stringify({
      urls,
      batchName,
      forceReplace,
      mergeAudio: opts.mergeAudio === true,
      mergeFormat: opts.mergeFormat === "wav" ? "wav" : "mp3",
    }),
  });
}

export function startJob(id: string, token: string): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/api/jobs/${encodeURIComponent(id)}/start`, {
    method: "POST",
    body: JSON.stringify({ token }),
  });
}

export function getJob(
  id: string,
): Promise<{ job: JobSummary; items: FileItem[] }> {
  return request<{ job: JobSummary; items: FileItem[] }>(
    `/api/jobs/${encodeURIComponent(id)}`,
  );
}

export function cancelJob(id: string, token: string): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/api/jobs/${encodeURIComponent(id)}/cancel`, {
    method: "POST",
    body: JSON.stringify({ token }),
  });
}

/** SSE endpoint for live job updates (no auth header needed). */
export function eventsUrl(id: string): string {
  return `/api/jobs/${encodeURIComponent(id)}/events`;
}

/** Direct download links. The token is a per-job credential issued by the API. */
export function zipDownloadUrl(id: string, token: string): string {
  return `/api/jobs/${encodeURIComponent(id)}/zip?token=${encodeURIComponent(token)}`;
}

/** Merged single audio file (only for jobs created with mergeAudio). */
export function mergedDownloadUrl(id: string, token: string): string {
  return `/api/jobs/${encodeURIComponent(id)}/merged?token=${encodeURIComponent(token)}`;
}

export function reportDownloadUrl(id: string, token: string): string {
  return `/api/jobs/${encodeURIComponent(id)}/report?token=${encodeURIComponent(token)}`;
}

export function fileDownloadUrl(
  id: string,
  position: number,
  token: string,
): string {
  return `/api/jobs/${encodeURIComponent(id)}/files/${position}?token=${encodeURIComponent(token)}`;
}

/** Triggers a real browser file download for a same-origin URL. */
export function triggerFileDownload(href: string, filename?: string): void {
  const a = document.createElement("a");
  a.href = href;
  if (filename) a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}
