import type {
  ExtensionSource,
  UrlRejection,
  ValidationIssue,
  ValidationResult,
} from "../types";

const SOURCE_LABEL: Record<ExtensionSource, string> = {
  "content-disposition": "Content-Disposition",
  "url-path": "URL path",
  "content-sniff": "Content sniff",
  unknown: "Unknown",
};

function IssueRow({ issue }: { issue: ValidationIssue }) {
  return (
    <li
      className={`rounded-lg border p-3 ${
        issue.valid
          ? "border-slate-800 bg-slate-950/60"
          : "border-red-900/60 bg-red-950/20"
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs text-slate-500">
          #{issue.position}
        </span>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
            issue.valid
              ? "bg-emerald-500/15 text-emerald-300"
              : "bg-red-500/15 text-red-300"
          }`}
        >
          {issue.valid ? "Valid" : "Invalid"}
        </span>
        {issue.extension ? (
          <span className="rounded-full bg-slate-800 px-2 py-0.5 font-mono text-xs text-slate-300">
            .{issue.extension}
            {issue.extensionSource && (
              <span className="text-slate-500">
                {" "}
                · {SOURCE_LABEL[issue.extensionSource]}
              </span>
            )}
          </span>
        ) : (
          <span className="rounded-full bg-slate-800 px-2 py-0.5 font-mono text-xs text-slate-500">
            no extension
          </span>
        )}
      </div>
      <p className="mt-1.5 break-all font-mono text-xs text-slate-400">
        {issue.url}
      </p>
      {issue.problems.length > 0 && (
        <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-xs text-red-300/90">
          {issue.problems.map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ul>
      )}
      {issue.extensionWarning && (
        <p className="mt-1.5 rounded bg-amber-500/10 px-2 py-1 text-xs text-amber-300">
          ⚠ {issue.extensionWarning}
        </p>
      )}
    </li>
  );
}

interface ValidationPanelProps {
  validation: ValidationResult | null;
  ackWarnings: boolean;
  onAckChange: (checked: boolean) => void;
  urlErrors: UrlRejection[];
}

export function ValidationPanel({
  validation,
  ackWarnings,
  onAckChange,
  urlErrors,
}: ValidationPanelProps) {
  if (!validation && urlErrors.length === 0) return null;

  return (
    <section
      aria-label="Validation results"
      className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 shadow-xl shadow-black/20"
    >
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-slate-400">
        Validation
      </h2>

      {urlErrors.length > 0 && (
        <div
          role="alert"
          className="mb-4 rounded-lg border border-red-900/60 bg-red-950/30 p-3"
        >
          <p className="text-sm font-medium text-red-200">
            The server rejected {urlErrors.length}{" "}
            {urlErrors.length === 1 ? "URL" : "URLs"}:
          </p>
          <ul className="mt-2 space-y-1">
            {urlErrors.map((e) => (
              <li key={e.position} className="text-xs text-red-300">
                <span className="font-mono text-red-400">#{e.position}</span>{" "}
                <span className="break-all font-mono">{e.url}</span> — {e.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {validation && (
        <>
          <div className="mb-3 flex flex-wrap gap-2 text-xs">
            <span className="rounded-full bg-slate-800 px-2.5 py-1 text-slate-300">
              {validation.total} checked
            </span>
            {validation.invalid > 0 ? (
              <span className="rounded-full bg-red-500/15 px-2.5 py-1 font-medium text-red-300">
                {validation.invalid} invalid — fix these to start
              </span>
            ) : (
              <span className="rounded-full bg-emerald-500/15 px-2.5 py-1 font-medium text-emerald-300">
                all valid
              </span>
            )}
            {validation.warnings > 0 && (
              <span className="rounded-full bg-amber-500/15 px-2.5 py-1 font-medium text-amber-300">
                {validation.warnings}{" "}
                {validation.warnings === 1 ? "warning" : "warnings"}
              </span>
            )}
          </div>

          {validation.warnings > 0 && validation.invalid === 0 && (
            <label className="mb-3 flex cursor-pointer items-start gap-2 rounded-lg border border-amber-900/60 bg-amber-950/20 p-3 text-sm text-amber-200">
              <input
                type="checkbox"
                checked={ackWarnings}
                onChange={(e) => onAckChange(e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-amber-500"
              />
              <span>
                I understand that some URLs have no reliable file extension and
                may be packaged with a generic name. Start anyway.
              </span>
            </label>
          )}

          <ul className="max-h-72 space-y-2 overflow-y-auto pr-1">
            {validation.issues.map((issue) => (
              <IssueRow key={issue.position} issue={issue} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
