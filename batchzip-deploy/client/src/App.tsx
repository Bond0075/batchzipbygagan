import { useCallback, useEffect, useMemo, useState } from "react";
import { Header } from "./components/Header";
import { UrlPanel } from "./components/UrlPanel";
import { ValidationPanel } from "./components/ValidationPanel";
import { ProgressPanel } from "./components/ProgressPanel";
import { FileTable } from "./components/FileTable";
import { CompletionPanel } from "./components/CompletionPanel";
import { Modal } from "./components/Modal";
import {
  ApiError,
  cancelJob,
  createJob,
  getConfig,
  getJob,
  startJob,
  validateUrls,
} from "./api";
import { useJobUpdates, type JobUpdate } from "./hooks/useJobUpdates";
import { defaultBatchName, parseUrlLines } from "./format";
import {
  isTerminalPhase,
  type FileItem,
  type JobSummary,
  type ServerConfig,
  type UrlRejection,
  type ValidationResult,
} from "./types";

const STORAGE_KEY = "batchzip.job";

interface StoredSession {
  jobId: string;
  token: string;
}

function loadSession(): StoredSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredSession;
    if (typeof parsed.jobId === "string" && typeof parsed.token === "string") {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export default function App() {
  const [urlsText, setUrlsText] = useState("");
  const [batchName, setBatchName] = useState(() => defaultBatchName());
  const [mergeAudio, setMergeAudio] = useState(false);
  const [mergeFormat, setMergeFormat] = useState<"mp3" | "wav">("mp3");

  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);

  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [validating, setValidating] = useState(false);
  const [ackWarnings, setAckWarnings] = useState(false);
  const [urlErrors, setUrlErrors] = useState<UrlRejection[]>([]);

  const [job, setJob] = useState<JobSummary | null>(null);
  const [items, setItems] = useState<FileItem[]>([]);
  const [token, setToken] = useState<string | null>(null);

  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [conflict, setConflict] = useState<{ suggestion: string } | null>(null);
  const [replaceConfirmed, setReplaceConfirmed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const urls = useMemo(() => parseUrlLines(urlsText), [urlsText]);

  const downloading =
    job !== null && (job.phase === "downloading" || job.phase === "packaging");
  const terminal = job !== null && isTerminalPhase(job.phase);
  const createdIdle = job !== null && job.phase === "created";

  // ---- initial load: config + resume persisted job -------------------------
  useEffect(() => {
    getConfig()
      .then(setConfig)
      .catch((e: unknown) =>
        setConfigError(e instanceof Error ? e.message : "request failed"),
      );

    const session = loadSession();
    if (!session) return;
    getJob(session.jobId)
      .then(({ job: j, items: it }) => {
        setJob(j);
        setItems(it);
        setToken(session.token);
      })
      .catch(() => {
        // Job gone or expired — drop the stale session.
        localStorage.removeItem(STORAGE_KEY);
      });
  }, []);

  // ---- live updates (SSE with polling fallback) ------------------------------
  const handleUpdate = useCallback((u: JobUpdate) => {
    setJob(u.job);
    setItems(u.items);
    setCancelling(false);
  }, []);
  const handleTerminal = useCallback(() => {
    setCancelling(false);
    setStarting(false);
  }, []);
  useJobUpdates(job?.id ?? null, handleUpdate, handleTerminal);

  // ---- URL input --------------------------------------------------------------
  const handleUrlsChange = (text: string) => {
    setUrlsText(text);
    // Validation results only apply to the exact text that was validated.
    setValidation(null);
    setAckWarnings(false);
    setUrlErrors([]);
  };

  const handleValidate = async () => {
    if (urls.length === 0 || validating) return;
    setValidating(true);
    setNotice(null);
    try {
      const result = await validateUrls(urls);
      setValidation(result);
      setAckWarnings(false);
    } catch (e) {
      setNotice(
        e instanceof Error ? e.message : "Validation failed. Please try again.",
      );
    } finally {
      setValidating(false);
    }
  };

  const handleClear = () => {
    setUrlsText("");
    setValidation(null);
    setAckWarnings(false);
    setUrlErrors([]);
  };

  // ---- job lifecycle ------------------------------------------------------------
  const persistSession = (jobId: string, tok: string) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ jobId, token: tok }));
    } catch {
      // Storage unavailable (private mode) — the job still works for this tab.
    }
  };

  const doCreate = async (name: string, forceReplace: boolean) => {
    setStarting(true);
    setNotice(null);
    setUrlErrors([]);
    try {
      const res = await createJob(urls, name, forceReplace, {
        mergeAudio,
        mergeFormat,
      });
      persistSession(res.job.id, res.token);
      setToken(res.token);
      setJob(res.job);
      setItems(res.items);
      await startJob(res.job.id, res.token);
    } catch (e) {
      if (e instanceof ApiError && e.code === "BATCH_NAME_EXISTS") {
        setConflict({ suggestion: e.suggestion ?? `${name}-2` });
      } else if (e instanceof ApiError && e.code === "URLS_REJECTED") {
        setUrlErrors(e.bad ?? []);
        setNotice("The server rejected some URLs — see the details below.");
      } else {
        setNotice(
          e instanceof Error ? e.message : "Could not start the job.",
        );
      }
    } finally {
      setStarting(false);
    }
  };

  const handleStart = () => {
    if (starting || downloading) return;
    // Retry a job that was created but never started (e.g. 429 on start).
    if (createdIdle && job && token) {
      setStarting(true);
      setNotice(null);
      startJob(job.id, token)
        .catch((e: unknown) =>
          setNotice(e instanceof Error ? e.message : "Could not start the job."),
        )
        .finally(() => setStarting(false));
      return;
    }
    const name = batchName.trim() || defaultBatchName();
    setBatchName(name);
    void doCreate(name, false);
  };

  const handleUseSuggestion = () => {
    if (!conflict) return;
    const name = conflict.suggestion;
    setConflict(null);
    setReplaceConfirmed(false);
    setBatchName(name);
    void doCreate(name, false);
  };

  const handleReplace = () => {
    if (!conflict) return;
    setConflict(null);
    setReplaceConfirmed(false);
    void doCreate(batchName.trim() || defaultBatchName(), true);
  };

  const handleCancel = () => {
    if (!job || !token || cancelling) return;
    setCancelling(true);
    cancelJob(job.id, token).catch((e: unknown) => {
      setCancelling(false);
      setNotice(e instanceof Error ? e.message : "Could not cancel the job.");
    });
  };

  const handleNewBatch = () => {
    setJob(null);
    setItems([]);
    setToken(null);
    setValidation(null);
    setAckWarnings(false);
    setUrlErrors([]);
    setNotice(null);
    setBatchName(defaultBatchName());
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
  };

  // ---- derived UI state ------------------------------------------------------------
  const hasInvalid = validation !== null && validation.invalid > 0;
  const hasWarnings = validation !== null && validation.warnings > 0;

  const canStart =
    !starting &&
    !downloading &&
    !terminal &&
    urls.length > 0 &&
    !hasInvalid &&
    (!hasWarnings || ackWarnings);

  let startDisabledReason: string | null = null;
  if (!downloading) {
    if (terminal) {
      startDisabledReason =
        "This batch is finished. Use “Start new batch” below to run again.";
    } else if (urls.length === 0) {
      startDisabledReason = "Paste at least one URL to start.";
    } else if (hasInvalid) {
      startDisabledReason = "Fix the invalid URLs in the validation panel first.";
    } else if (hasWarnings && !ackWarnings) {
      startDisabledReason =
        "Check the acknowledgement box in the validation panel to start anyway.";
    }
  }

  const currentFilename =
    job?.currentPosition != null
      ? (items[job.currentPosition - 1]?.filename ?? null)
      : null;

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200">
      <Header config={config} configError={configError} />

      <main className="mx-auto max-w-6xl space-y-6 px-4 py-6">
        {notice && (
          <div
            role="alert"
            className="flex items-start justify-between gap-3 rounded-xl border border-red-900/60 bg-red-950/30 px-4 py-3 text-sm text-red-200"
          >
            <p>{notice}</p>
            <button
              type="button"
              onClick={() => setNotice(null)}
              aria-label="Dismiss"
              className="shrink-0 rounded px-1.5 py-0.5 text-red-300 hover:bg-red-900/40"
            >
              ✕
            </button>
          </div>
        )}

        <div className="grid gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <UrlPanel
              urlsText={urlsText}
              onUrlsChange={handleUrlsChange}
              urlCount={urls.length}
              batchName={batchName}
              onBatchNameChange={setBatchName}
              mergeAudio={mergeAudio}
              onMergeAudioChange={setMergeAudio}
              mergeFormat={mergeFormat}
              onMergeFormatChange={setMergeFormat}
              onValidate={handleValidate}
              onClear={handleClear}
              onStart={handleStart}
              onCancel={handleCancel}
              validating={validating}
              starting={starting}
              cancelling={cancelling}
              canStart={canStart}
              startDisabledReason={startDisabledReason}
              jobRunning={downloading}
              hasJob={terminal}
            />
          </div>

          <aside
            aria-label="How it works"
            className="h-fit rounded-xl border border-slate-800 bg-slate-900/60 p-5 shadow-xl shadow-black/20"
          >
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-slate-400">
              How it works
            </h2>
            <ol className="space-y-3 text-sm text-slate-300">
              {[
                ["1", "Paste URLs", "One per line, in the order you want them."],
                ["2", "Validate", "Checks URLs, extensions, and SSRF safety."],
                ["3", "Download", "Strictly sequential — one file at a time, with retries and verification."],
                ["4", "ZIP", "Verified files packaged as 1.wav, 2.mp3, … in numeric order."],
              ].map(([n, title, desc]) => (
                <li key={n} className="flex gap-3">
                  <span
                    aria-hidden
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-indigo-600/20 text-xs font-semibold text-indigo-300"
                  >
                    {n}
                  </span>
                  <span>
                    <span className="font-medium text-slate-100">{title}.</span>{" "}
                    <span className="text-slate-400">{desc}</span>
                  </span>
                </li>
              ))}
            </ol>
            <p className="mt-4 border-t border-slate-800 pt-3 text-xs leading-relaxed text-slate-500">
              Files are stored temporarily on the server and deleted
              automatically after the retention period. Only direct HTTP(S)
              download URLs are fetched — localhost, private IPs, and metadata
              endpoints are blocked.
            </p>
          </aside>
        </div>

        <ValidationPanel
          validation={validation}
          ackWarnings={ackWarnings}
          onAckChange={setAckWarnings}
          urlErrors={urlErrors}
        />

        {job && token && (
          <>
            <ProgressPanel job={job} currentFilename={currentFilename} />
            <FileTable items={items} jobId={job.id} token={token} />
          </>
        )}

        {job && token && terminal && (
          <CompletionPanel job={job} token={token} onNewBatch={handleNewBatch} />
        )}

        {conflict && (
          <Modal
            title="Batch name already exists"
            onClose={() => {
              setConflict(null);
              setReplaceConfirmed(false);
            }}
            actions={
              <>
                <button
                  type="button"
                  onClick={() => {
                    setConflict(null);
                    setReplaceConfirmed(false);
                  }}
                  className="rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-700"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleUseSuggestion}
                  className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
                >
                  Use “{conflict.suggestion}”
                </button>
              </>
            }
          >
            <p>
              A batch named{" "}
              <span className="font-mono text-slate-100">
                {batchName.trim() || defaultBatchName()}
              </span>{" "}
              already exists. You can use the suggested unique name, or replace
              the existing batch.
            </p>
            <label className="mt-4 flex cursor-pointer items-start gap-2 rounded-lg border border-red-900/60 bg-red-950/20 p-3">
              <input
                type="checkbox"
                checked={replaceConfirmed}
                onChange={(e) => setReplaceConfirmed(e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-red-500"
              />
              <span className="text-sm text-red-200">
                Yes, replace the existing batch — I understand its files will be
                permanently deleted.
              </span>
            </label>
            <button
              type="button"
              onClick={handleReplace}
              disabled={!replaceConfirmed}
              className="mt-3 w-full rounded-lg bg-red-600/90 px-4 py-2 text-sm font-medium text-white hover:bg-red-500 disabled:cursor-not-allowed disabled:bg-slate-800 disabled:text-slate-500"
            >
              Replace existing batch
            </button>
          </Modal>
        )}
      </main>

      <footer className="border-t border-slate-800/80 py-5">
        <p className="mx-auto max-w-6xl px-4 text-center text-xs text-slate-600">
          BatchZip Downloader · downloads run server-side, sequentially, with
          verification and automatic cleanup.
        </p>
      </footer>
    </div>
  );
}
