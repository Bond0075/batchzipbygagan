import { useEffect, useState } from "react";
import type { JobSummary } from "../types";
import { formatBytes, formatClock, formatCount, formatSpeed } from "../format";
import { isRunningPhase } from "../types";

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2">
      <div className="text-[11px] uppercase tracking-wider text-slate-500">
        {label}
      </div>
      <div className="mt-0.5 font-mono text-sm text-slate-100">{value}</div>
    </div>
  );
}

/** Live elapsed-time ticker; ticks while the job is running. */
function useElapsed(job: JobSummary): string {
  const [now, setNow] = useState(() => Date.now());
  const running = isRunningPhase(job.phase);

  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [running]);

  if (job.elapsedMs !== null && !running) {
    return formatClock(job.elapsedMs);
  }
  if (job.startedAt) {
    const started = new Date(job.startedAt).getTime();
    if (!Number.isNaN(started)) return formatClock(Math.max(0, now - started));
  }
  return "—";
}

export function ProgressPanel({
  job,
  currentFilename,
}: {
  job: JobSummary;
  currentFilename: string | null;
}) {
  const elapsed = useElapsed(job);
  const pct =
    job.total > 0 ? Math.min(100, Math.round((job.done / job.total) * 100)) : 0;
  const running = isRunningPhase(job.phase);

  return (
    <section
      aria-label="Download progress"
      className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 shadow-xl shadow-black/20"
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400">
          Progress
        </h2>
        <div className="flex flex-wrap gap-1.5 text-xs" aria-live="polite">
          <span className="rounded-full bg-emerald-500/15 px-2.5 py-1 font-medium text-emerald-300">
            {job.succeeded} succeeded
          </span>
          {job.failed > 0 && (
            <span className="rounded-full bg-red-500/15 px-2.5 py-1 font-medium text-red-300">
              {job.failed} failed
            </span>
          )}
          {job.cancelledCount > 0 && (
            <span className="rounded-full bg-purple-500/15 px-2.5 py-1 font-medium text-purple-300">
              {job.cancelledCount} cancelled
            </span>
          )}
        </div>
      </div>

      <div className="flex items-baseline justify-between gap-2">
        <p className="text-lg font-semibold text-slate-100">
          {formatCount(job.done)}{" "}
          <span className="text-sm font-normal text-slate-400">
            of {formatCount(job.total)} files processed
          </span>
        </p>
        <p className="font-mono text-sm text-slate-400">{pct}%</p>
      </div>

      <div
        className="mt-2 h-3 overflow-hidden rounded-full bg-slate-800"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${job.done} of ${job.total} files processed`}
      >
        <div
          className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-violet-500 transition-[width] duration-500 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>

      {job.phase === "merging" && (
        <p className="mt-3 text-sm text-slate-300" aria-live="polite">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-violet-400" />{" "}
          <span className="font-medium text-slate-100">
            Merging audio files in sequence…
          </span>{" "}
          <span className="text-slate-500">
            (1 → {job.total} order me jod raha hoon)
          </span>
        </p>
      )}

      {running && job.currentPosition !== null && job.phase !== "merging" && (
        <p className="mt-3 text-sm text-slate-300" aria-live="polite">
          <span className="text-slate-500">Current file:</span>{" "}
          <span className="font-medium text-slate-100">
            File {job.currentPosition} of {job.total}
          </span>
          {currentFilename && (
            <span className="font-mono text-slate-400"> — {currentFilename}</span>
          )}
        </p>
      )}

      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Elapsed" value={elapsed} />
        <Stat label="Downloaded" value={formatBytes(job.totalBytes)} />
        <Stat label="Speed" value={formatSpeed(job.bytesPerSecond)} />
        <Stat label="Batch" value={job.batchName} />
      </div>
    </section>
  );
}
