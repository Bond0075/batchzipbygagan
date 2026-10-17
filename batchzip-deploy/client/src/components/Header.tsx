import type { ServerConfig } from "../types";
import { formatBytes } from "../format";

interface HeaderProps {
  config: ServerConfig | null;
  configError: string | null;
}

function LimitItem({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className="text-slate-500">{label}</span>
      <span className="font-medium text-slate-200 underline decoration-slate-700 decoration-dotted underline-offset-4">
        {value}
      </span>
    </span>
  );
}

export function Header({ config, configError }: HeaderProps) {
  return (
    <header className="border-b border-slate-800/80 bg-slate-950/80">
      <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <div
              aria-hidden
              className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 shadow-lg shadow-indigo-950"
            >
              <svg
                viewBox="0 0 24 24"
                className="h-5 w-5 text-white"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight text-slate-50">
                BatchZip Downloader
              </h1>
              <p className="text-sm text-slate-400">
                Sequential bulk downloads, verified &amp; zipped in order.
              </p>
            </div>
          </div>
        </div>
        <div className="text-xs text-slate-400" aria-live="polite">
          {configError ? (
            <span className="text-amber-300">
              Server limits unavailable — {configError}
            </span>
          ) : config ? (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <LimitItem
                label="Max URLs"
                value={String(config.maxUrlsPerBatch)}
              />
              <LimitItem
                label="Max file size"
                value={formatBytes(config.maxFileSizeBytes)}
              />
              <LimitItem
                label="Max batch"
                value={formatBytes(config.maxBatchBytes)}
              />
              <LimitItem
                label="Retention"
                value={`${config.batchRetentionHours}h`}
              />
            </div>
          ) : (
            <span className="text-slate-500">Loading server limits…</span>
          )}
        </div>
      </div>
    </header>
  );
}
