interface UrlPanelProps {
  urlsText: string;
  onUrlsChange: (text: string) => void;
  urlCount: number;
  batchName: string;
  onBatchNameChange: (name: string) => void;
  mergeAudio: boolean;
  onMergeAudioChange: (v: boolean) => void;
  mergeFormat: "mp3" | "wav";
  onMergeFormatChange: (f: "mp3" | "wav") => void;
  onValidate: () => void;
  onClear: () => void;
  onStart: () => void;
  onCancel: () => void;
  validating: boolean;
  starting: boolean;
  cancelling: boolean;
  canStart: boolean;
  startDisabledReason: string | null;
  jobRunning: boolean;
  hasJob: boolean;
}

function Button({
  children,
  onClick,
  disabled,
  variant = "secondary",
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  title?: string;
}) {
  const styles: Record<string, string> = {
    primary:
      "bg-indigo-600 text-white hover:bg-indigo-500 disabled:bg-slate-800 disabled:text-slate-500 shadow-lg shadow-indigo-950/60",
    secondary:
      "bg-slate-800 text-slate-200 hover:bg-slate-700 disabled:bg-slate-800/50 disabled:text-slate-600 border border-slate-700",
    danger:
      "bg-red-600/90 text-white hover:bg-red-500 disabled:bg-slate-800 disabled:text-slate-500",
    ghost: "text-slate-400 hover:text-slate-200 hover:bg-slate-800/70 disabled:text-slate-600",
  };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 disabled:cursor-not-allowed ${styles[variant]}`}
    >
      {children}
    </button>
  );
}

export function UrlPanel(props: UrlPanelProps) {
  const {
    urlsText,
    onUrlsChange,
    urlCount,
    batchName,
    onBatchNameChange,
    mergeAudio,
    onMergeAudioChange,
    mergeFormat,
    onMergeFormatChange,
    onValidate,
    onClear,
    onStart,
    onCancel,
    validating,
    starting,
    cancelling,
    canStart,
    startDisabledReason,
    jobRunning,
    hasJob,
  } = props;

  return (
    <section
      aria-label="URLs and batch controls"
      className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 shadow-xl shadow-black/20"
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400">
          Download URLs
        </h2>
        <p className="text-sm text-slate-400" aria-live="polite">
          <span className="font-semibold text-slate-100">{urlCount}</span>{" "}
          {urlCount === 1 ? "URL" : "URLs"} detected
        </p>
      </div>

      <label htmlFor="url-input" className="sr-only">
        Paste one download URL per line
      </label>
      <textarea
        id="url-input"
        rows={10}
        value={urlsText}
        onChange={(e) => onUrlsChange(e.target.value)}
        disabled={jobRunning}
        spellCheck={false}
        placeholder={"https://example.com/audio-a.wav\nhttps://example.com/audio-b.wav\nhttps://example.com/document.pdf\nhttps://example.com/music.mp3"}
        className="w-full resize-y rounded-lg border border-slate-700 bg-slate-950 p-3 font-mono text-sm leading-relaxed text-slate-200 placeholder:text-slate-600 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-60"
      />
      <p className="mt-1.5 text-xs text-slate-500">
        One URL per line, in the exact order you want them packaged. Files are
        renamed to <span className="font-mono text-slate-400">1.wav</span>,{" "}
        <span className="font-mono text-slate-400">2.mp3</span>, … by line
        position.
      </p>

      <div className="mt-4">
        <label
          htmlFor="batch-name"
          className="mb-1 block text-xs font-medium uppercase tracking-wider text-slate-400"
        >
          Batch name
        </label>
        <input
          id="batch-name"
          type="text"
          value={batchName}
          onChange={(e) => onBatchNameChange(e.target.value)}
          disabled={jobRunning}
          maxLength={80}
          spellCheck={false}
          className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-sm text-slate-200 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-60"
        />
      </div>

      <div className="mt-4 rounded-lg border border-slate-800 bg-slate-950/60 p-3">
        <label className="flex cursor-pointer items-center gap-2.5 text-sm text-slate-200">
          <input
            type="checkbox"
            checked={mergeAudio}
            onChange={(e) => onMergeAudioChange(e.target.checked)}
            disabled={jobRunning}
            className="h-4 w-4 accent-indigo-500 disabled:opacity-60"
          />
          <span className="font-medium">
            🔗 Audios ko merge karke <span className="font-semibold">ek file</span> banao
          </span>
        </label>
        <p className="mt-1.5 pl-6 text-xs text-slate-500">
          Saare audio links sequence me download honge, phir 1, 2, 3… order me
          jod ke ek hi audio file ban jayegi.
        </p>
        {mergeAudio && (
          <label className="mt-2 flex items-center gap-2 pl-6 text-xs text-slate-400">
            Output format:
            <select
              value={mergeFormat}
              onChange={(e) => onMergeFormatChange(e.target.value as "mp3" | "wav")}
              disabled={jobRunning}
              className="rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-sm text-slate-200 focus:border-indigo-500 focus:outline-none disabled:opacity-60"
            >
              <option value="mp3">MP3</option>
              <option value="wav">WAV</option>
            </select>
          </label>
        )}
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button onClick={onValidate} disabled={validating || urlCount === 0 || jobRunning}>
          {validating ? "Validating…" : "Validate URLs"}
        </Button>
        <Button onClick={onClear} disabled={urlCount === 0 || jobRunning} variant="ghost">
          Clear URLs
        </Button>
        <span className="mx-1 hidden w-px bg-slate-800 sm:block" aria-hidden />
        {!jobRunning ? (
          <span title={startDisabledReason ?? undefined}>
            <Button
              onClick={onStart}
              disabled={!canStart}
              variant="primary"
            >
              {starting ? "Starting…" : hasJob ? "Job finished — start a new batch below" : "Start Download"}
            </Button>
          </span>
        ) : (
          <Button onClick={onCancel} disabled={cancelling} variant="danger">
            {cancelling ? "Cancelling…" : "Cancel Job"}
          </Button>
        )}
      </div>

      {startDisabledReason && !jobRunning && (
        <p className="mt-2 text-xs text-amber-300/90">{startDisabledReason}</p>
      )}
    </section>
  );
}
