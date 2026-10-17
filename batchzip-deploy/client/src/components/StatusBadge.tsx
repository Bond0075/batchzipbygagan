import type { FileStatus } from "../types";

const STYLES: Record<FileStatus, string> = {
  pending: "bg-slate-700/40 text-slate-300 border-slate-600/60",
  downloading: "bg-blue-500/15 text-blue-300 border-blue-500/40",
  retrying: "bg-amber-500/15 text-amber-300 border-amber-500/40",
  verified: "bg-emerald-500/15 text-emerald-300 border-emerald-500/40",
  failed: "bg-red-500/15 text-red-300 border-red-500/40",
  cancelled: "bg-purple-500/15 text-purple-300 border-purple-500/40",
  packaged: "bg-teal-500/15 text-teal-300 border-teal-500/40",
};

const DOT: Record<FileStatus, string> = {
  pending: "bg-slate-400",
  downloading: "bg-blue-400 animate-pulse",
  retrying: "bg-amber-400 animate-pulse",
  verified: "bg-emerald-400",
  failed: "bg-red-400",
  cancelled: "bg-purple-400",
  packaged: "bg-teal-400",
};

export function StatusBadge({ status }: { status: FileStatus }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium capitalize ${STYLES[status]}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${DOT[status]}`} aria-hidden />
      {status}
    </span>
  );
}
