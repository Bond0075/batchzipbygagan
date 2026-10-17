import { useEffect, useRef } from "react";
import type { FileItem, JobSummary } from "../types";
import { eventsUrl, getJob } from "../api";
import { isTerminalPhase } from "../types";

export interface JobUpdate {
  job: JobSummary;
  items: FileItem[];
}

const POLL_INTERVAL_MS = 1500;

/**
 * Subscribes to live job updates. Primary transport is SSE
 * (/api/jobs/:id/events); if the stream errors, falls back to polling
 * GET /api/jobs/:id every 1.5s. Cleans up on unmount or job change.
 */
export function useJobUpdates(
  jobId: string | null,
  onUpdate: (update: JobUpdate) => void,
  onTerminal: () => void,
): void {
  const updateRef = useRef(onUpdate);
  updateRef.current = onUpdate;
  const terminalRef = useRef(onTerminal);
  terminalRef.current = onTerminal;

  useEffect(() => {
    if (!jobId) return;

    let stopped = false;
    let pollTimer: number | null = null;
    let es: EventSource | null = null;

    const apply = (update: JobUpdate) => {
      if (!stopped) updateRef.current(update);
    };

    const finish = () => {
      if (stopped) return;
      cleanup();
      terminalRef.current();
    };

    const cleanup = () => {
      if (es) {
        es.close();
        es = null;
      }
      if (pollTimer !== null) {
        window.clearInterval(pollTimer);
        pollTimer = null;
      }
    };

    const startPolling = () => {
      if (pollTimer !== null || stopped) return;
      const poll = async () => {
        try {
          const update = await getJob(jobId);
          apply(update);
          if (isTerminalPhase(update.job.phase)) finish();
        } catch {
          // Transient poll failure: keep polling; the next tick may succeed.
        }
      };
      void poll();
      pollTimer = window.setInterval(() => void poll(), POLL_INTERVAL_MS);
    };

    let sseStarted = false;
    try {
      es = new EventSource(eventsUrl(jobId));
      es.addEventListener("progress", (event) => {
        try {
          apply(JSON.parse((event as MessageEvent).data) as JobUpdate);
        } catch {
          // Ignore malformed frames; the next frame/poll will correct state.
        }
      });
      es.addEventListener("done", (event) => {
        try {
          apply(JSON.parse((event as MessageEvent).data) as JobUpdate);
        } catch {
          // Even without a payload, the phase is terminal.
        }
        finish();
      });
      es.onerror = () => {
        if (stopped) return;
        // Stream failed (network hiccup, proxy buffering, etc.) — poll instead.
        if (es) {
          es.close();
          es = null;
        }
        startPolling();
      };
      sseStarted = true;
    } catch {
      sseStarted = false;
    }
    if (!sseStarted) startPolling();

    return () => {
      stopped = true;
      cleanup();
    };
  }, [jobId]);
}
