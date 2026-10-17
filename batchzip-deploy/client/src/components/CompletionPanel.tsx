import { useState } from "react";
import type { JobSummary } from "../types";
import { Modal } from "./Modal";
import {
  mergedDownloadUrl,
  reportDownloadUrl,
  triggerFileDownload,
  zipDownloadUrl,
} from "../api";
import { formatBytes } from "../format";

interface CompletionPanelProps {
  job: JobSummary;
  token: string;
  onNewBatch: () => void;
}

function ActionButton({
  children,
  onClick,
  variant = "secondary",
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  variant?: "primary" | "secondary";
  disabled?: boolean;
}) {
  const styles =
    variant === "primary"
      ? "bg-indigo-600 text-white hover:bg-indigo-500 shadow-lg shadow-indigo-950/60"
      : "bg-slate-800 text-slate-200 hover:bg-slate-700 border border-slate-700";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 disabled:cursor-not-allowed disabled:opacity-50 ${styles}`}
    >
      {children}
    </button>
  );
}

export function CompletionPanel({ job, token, onNewBatch }: CompletionPanelProps) {
  const [zipConfirm, setZipConfirm] = useState(false);

  const downloadReport = () =>
    triggerFileDownload(
      reportDownloadUrl(job.id, token),
      `${job.batchName}-report.csv`,
    );

  const downloadZip = () =>
    triggerFileDownload(zipDownloadUrl(job.id, token), job.zipName ?? undefined);

  const downloadMerged = () =>
    triggerFileDownload(
      mergedDownloadUrl(job.id, token),
      job.mergedName ?? undefined,
    );

  const failed = job.failed;
  const total = job.total;

  return (
    <section
      aria-label="Batch result"
      className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 shadow-xl shadow-black/20"
    >
      {job.phase === "completed" && (
        <>
          <div className="flex items-center gap-3">
            <div
              aria-hidden
              className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-500/15"
            >
              <svg viewBox="0 0 24 24" className="h-5 w-5 text-emerald-300" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
            <div>
              <h2 className="text-base font-semibold text-slate-100">
                Batch complete
              </h2>
              <p className="text-sm text-slate-400">
                {job.succeeded} of {total} files packaged
                {job.zipBytes !== null &&
                  ` · ZIP ${formatBytes(job.zipBytes)}`}
              </p>
            </div>
          </div>

          {failed > 0 && (
            <div
              role="alert"
              className="mt-4 rounded-lg border border-amber-900/60 bg-amber-950/25 p-3 text-sm text-amber-200"
            >
              <span className="font-semibold">
                {failed} of {total} files failed — see report.
              </span>{" "}
              The ZIP contains only the successfully verified files, in numeric
              position order. A failure report (
              <span className="font-mono">download-report.csv</span>) is included
              inside the ZIP.
            </div>
          )}

          <div className="mt-4 flex flex-wrap gap-2">
            {job.zipReady ? (
              <ActionButton variant="primary" onClick={() => setZipConfirm(true)}>
                Download ZIP
              </ActionButton>
            ) : (
              <p className="text-sm text-amber-300">
                The ZIP is still being prepared…
              </p>
            )}
            {job.mergeAudio && job.mergedReady && (
              <ActionButton variant="primary" onClick={downloadMerged}>
                🎙️ Download merged audio
                {job.mergedBytes !== null && ` (${formatBytes(job.mergedBytes)})`}
              </ActionButton>
            )}
            <ActionButton onClick={downloadReport}>
              Download failure report (CSV)
            </ActionButton>
            <ActionButton onClick={onNewBatch}>Start new batch</ActionButton>
          </div>

          {job.mergeAudio && job.mergeError && (
            <div
              role="alert"
              className="mt-4 rounded-lg border border-red-900/60 bg-red-950/25 p-3 text-sm text-red-200"
            >
              Audio merge failed: {job.mergeError} The individual files are still
              available in the ZIP above.
            </div>
          )}
        </>
      )}

      {(job.phase === "failed" || job.phase === "cancelled") && (
        <>
          <h2 className="text-base font-semibold text-slate-100">
            {job.phase === "failed" ? "Batch failed" : "Batch cancelled"}
          </h2>
          {job.error && (
            <div
              role="alert"
              className="mt-3 rounded-lg border border-red-900/60 bg-red-950/25 p-3 text-sm text-red-200"
            >
              {job.error}
            </div>
          )}
          <p className="mt-3 text-sm text-slate-400">
            {job.succeeded} of {total} files completed before the job ended.
            Completed downloads were preserved.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <ActionButton onClick={downloadReport}>
              Download failure report (CSV)
            </ActionButton>
            <ActionButton onClick={onNewBatch}>Start new batch</ActionButton>
          </div>
        </>
      )}

      {zipConfirm && (
        <Modal
          title="Download ZIP"
          onClose={() => setZipConfirm(false)}
          actions={
            <>
              <button
                type="button"
                onClick={() => setZipConfirm(false)}
                className="rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-sm font-medium text-slate-200 hover:bg-slate-700"
              >
                Cancel
              </button>
              <button
                type="button"
                autoFocus
                onClick={() => {
                  setZipConfirm(false);
                  downloadZip();
                }}
                className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
              >
                Download
              </button>
            </>
          }
        >
          <p>
            Download{" "}
            <span className="font-mono text-slate-100">
              {job.zipName ?? `${job.batchName}.zip`}
            </span>
            ?
          </p>
          <p className="mt-2">
            {job.succeeded} of {total} files succeeded
            {failed > 0 && (
              <span className="text-amber-300">, {failed} failed</span>
            )}
            .
          </p>
          {failed > 0 && (
            <p className="mt-2 text-amber-200">
              This is a partial batch: failed files are excluded from the ZIP
              but listed in the included failure report.
            </p>
          )}
        </Modal>
      )}
    </section>
  );
}
