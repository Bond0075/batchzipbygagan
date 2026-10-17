# BatchZip Downloader — Frontend API Contract

Base URL: same origin in production (`/api`), Vite dev proxy `/api` → `http://localhost:3001`.

## Endpoints

### POST /api/validate
Body: `{ "urls": string[] }`
Response 200: `{ total, invalid, warnings, issues: [{ position, url, valid, problems[], extension, extensionSource, extensionWarning }] }`
- `extensionWarning` non-null → show warning, require user confirmation before Start.

### POST /api/jobs
Body: `{ "urls": string[], "batchName": string, "forceReplace"?: boolean, "mergeAudio"?: boolean, "mergeFormat"?: "mp3"|"wav" }`
- 201: `{ job: JobSummary, token: string, items: FileItem[] }`
- 409 `{ code: "BATCH_NAME_EXISTS", suggestion }` → prompt user: use suggested unique name, or confirm replace (resend with `forceReplace: true`).
- 400 `{ code: "URLS_REJECTED", bad: [{position,url,reason}] }` → show per-URL errors.
- `mergeAudio: true` → after downloads, verified audio files are concatenated in numeric position order into one file (`batch-1-N-merged.mp3|wav`) via ffmpeg. Job passes through a `merging` phase. Mixed input codecs are re-encoded; files with no audio stream are skipped.

### POST /api/jobs/:id/start
Body: `{ "token": string }` → 200 `{ ok: true }`. 409 if already started, 429 if server busy.

### GET /api/jobs/:id
→ 200 `{ job: JobSummary, items: FileItem[] }`. Poll every ~1.5s as fallback.

### GET /api/jobs/:id/events
SSE. Events: `hello`, `progress` (same payload as GET), `done` (terminal phase reached, stream closes).

### POST /api/jobs/:id/cancel
Body: `{ "token": string }` → 200 `{ ok: true }`.

### GET /api/jobs/:id/zip?token=...
File download of `batch-1-N.zip`. 409 if not ready, 410 if expired.

### GET /api/jobs/:id/merged?token=...
File download of the merged audio (`batch-1-N-merged.mp3|wav`) — only for jobs created with `mergeAudio: true`. 409 if merge not enabled / not ready / merge failed (see `mergeError`), 410 if expired.

### GET /api/jobs/:id/report?token=...
CSV download of the failure report.

### GET /api/jobs/:id/files/:pos?token=...
Download one packaged file.

### GET /api/config
`{ maxUrlsPerBatch, maxFileSizeBytes, maxBatchBytes, requestTimeoutMs, retryCount, batchRetentionHours, maxConcurrentJobs }` — show limits in UI.

## Types

```ts
type FileStatus = "pending"|"downloading"|"retrying"|"verified"|"failed"|"cancelled"|"packaged";
type JobPhase = "created"|"downloading"|"packaging"|"merging"|"completed"|"failed"|"cancelled";
interface FileItem {
  position: number; url: string; status: FileStatus;
  attempts: number; retries: number; bytes: number;
  expectedBytes: number|null; filename: string|null; extension: string|null;
  extensionSource: "content-disposition"|"url-path"|"content-sniff"|"unknown"|null;
  extensionWarning: string|null; error: string|null;
  errorHistory: {attempt:number; error:string; at:string}[];
  startedAt: string|null; finishedAt: string|null; durationMs: number|null; bytesPerSecond: number|null;
}
interface JobSummary {
  id: string; batchName: string; phase: JobPhase;
  total: number; done: number; succeeded: number; failed: number; cancelledCount: number;
  totalBytes: number; startedAt: string|null; finishedAt: string|null;
  elapsedMs: number|null; bytesPerSecond: number|null; currentPosition: number|null;
  zipName: string|null; zipBytes: number|null; zipReady: boolean; error: string|null;
  mergeAudio: boolean; mergeFormat: "mp3"|"wav";
  mergedName: string|null; mergedBytes: number|null; mergedReady: boolean; mergeError: string|null;
  createdAt: string; updatedAt: string; expiresAt: string;
}
```

## UX rules
- Persist `{ jobId, token }` in localStorage; on load, if present, resume polling/SSE (survives refresh).
- Disable Start while phase is created→(starting), downloading, or packaging. Prevent double-start.
- Before ZIP download, show a modal warning: "X of N files succeeded, Y failed" when failed > 0.
- Statuses shown with distinct colors; table rows expandable to show errorHistory.
- Show elapsed time, total bytes, current file ("File 7 of 28 — 7.mp3"), speed; ETA only when bytesPerSecond and remaining bytes are known (we don't know remaining bytes upfront — show ETA only if meaningful, otherwise omit).
