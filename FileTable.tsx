import { Fragment, useState } from "react";
import type { FileItem } from "../types";
import { StatusBadge } from "./StatusBadge";
import { fileDownloadUrl, triggerFileDownload } from "../api";
import {
  formatBytes,
  formatDuration,
  formatSpeed,
  formatTimestamp,
} from "../format";

function Attempts({ item }: { item: FileItem }) {
  return (
    <span className="font-mono" title={`${item.attempts} attempts, ${item.retries} retries`}>
      {item.attempts}
      {item.retries > 0 && (
        <span className="text-amber-300"> (+{item.retries})</span>
      )}
    </span>
  );
}

function RowDetails({
  item,
  jobId,
  token,
}: {
  item: FileItem;
  jobId: string;
  token: string;
}) {
  return (
    <div className="space-y-3 px-4 py-3 text-xs">
      <div>
        <div className="mb-1 text-[11px] uppercase tracking-wider text-slate-500">
          Source URL
        </div>
        <p className="break-all font-mono text-slate-300">{item.url}</p>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div>
          <div className="text-[11px] uppercase tracking-wider text-slate-500">
            Expected size
          </div>
          <div className="font-mono text-slate-300">
            {formatBytes(item.expectedBytes)}
          </div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wider text-slate-500">
            Duration
          </div>
          <div className="font-mono text-slate-300">
            {formatDuration(item.durationMs)}
          </div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wider text-slate-500">
            Avg speed
          </div>
          <div className="font-mono text-slate-300">
            {formatSpeed(item.bytesPerSecond)}
          </div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wider text-slate-500">
            Extension source
          </div>
          <div className="font-mono text-slate-300">
            {item.extensionSource ?? "—"}
          </div>
        </div>
      </div>

      {item.status === "packaged" && item.filename && (
        <div>
          <button
            type="button"
            onClick={() =>
              triggerFileDownload(
                fileDownloadUrl(jobId, item.position, token),
                item.filename ?? undefined,
              )
            }
            className="text-indigo-300 underline decoration-indigo-700 underline-offset-4 hover:text-indigo-200"
          >
            Download this file ({item.filename})
          </button>
        </div>
      )}

      {item.errorHistory.length > 0 && (
        <div>
          <div className="mb-1 text-[11px] uppercase tracking-wider text-slate-500">
            Attempt history
          </div>
          <ol className="space-y-1.5">
            {item.errorHistory.map((h, i) => (
              <li
                key={i}
                className="rounded border border-slate-800 bg-slate-950/70 px-2.5 py-1.5"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-mono font-medium text-amber-300">
                    Attempt {h.attempt}
                  </span>
                  <span className="font-mono text-slate-500">
                    {formatTimestamp(h.at)}
                  </span>
                </div>
                <p className="mt-0.5 text-slate-300">{h.error}</p>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

export function FileTable({
  items,
  jobId,
  token,
}: {
  items: FileItem[];
  jobId: string;
  token: string;
}) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const toggle = (position: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(position)) next.delete(position);
      else next.add(position);
      return next;
    });
  };

  if (items.length === 0) return null;

  return (
    <section
      aria-label="File status"
      className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900/60 shadow-xl shadow-black/20"
    >
      <h2 className="border-b border-slate-800 px-5 py-4 text-sm font-semibold uppercase tracking-wider text-slate-400">
        Files
      </h2>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead>
            <tr className="border-b border-slate-800 text-xs uppercase tracking-wider text-slate-500">
              <th scope="col" className="px-4 py-2.5 font-medium">#</th>
              <th scope="col" className="px-4 py-2.5 font-medium">Filename</th>
              <th scope="col" className="px-4 py-2.5 font-medium">Status</th>
              <th scope="col" className="px-4 py-2.5 font-medium text-right">Size</th>
              <th scope="col" className="px-4 py-2.5 font-medium text-right">Attempts</th>
              <th scope="col" className="px-4 py-2.5 font-medium">Error</th>
              <th scope="col" className="px-4 py-2.5 font-medium">
                <span className="sr-only">Details</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const isOpen = expanded.has(item.position);
              return (
                <Fragment key={item.position}>
                  <tr
                    onClick={() => toggle(item.position)}
                    className="cursor-pointer border-b border-slate-800/60 transition-colors last:border-0 hover:bg-slate-800/40"
                  >
                    <td className="px-4 py-2.5 font-mono text-slate-400">
                      {item.position}
                    </td>
                    <td className="max-w-[220px] truncate px-4 py-2.5 font-mono text-slate-200" title={item.filename ?? item.url}>
                      {item.filename ?? <span className="text-slate-600">—</span>}
                    </td>
                    <td className="px-4 py-2.5">
                      <StatusBadge status={item.status} />
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono text-slate-300">
                      {item.bytes > 0 ? formatBytes(item.bytes) : "—"}
                    </td>
                    <td className="px-4 py-2.5 text-right text-slate-300">
                      <Attempts item={item} />
                    </td>
                    <td className="max-w-[240px] truncate px-4 py-2.5 text-xs text-red-300/90" title={item.error ?? undefined}>
                      {item.error ?? <span className="text-slate-600">—</span>}
                    </td>
                    <td className="px-4 py-2.5 text-slate-500">
                      <span aria-hidden>{isOpen ? "▾" : "▸"}</span>
                      <span className="sr-only">
                        {isOpen ? "Hide" : "Show"} details for file {item.position}
                      </span>
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className="border-b border-slate-800/60 bg-slate-950/50">
                      <td colSpan={7} className="p-0">
                        <RowDetails item={item} jobId={jobId} token={token} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
