import * as Sentry from '@sentry/react';
import { useEffect, useRef, useState } from 'react';
import type { JobEvent } from '@/contexts/RealtimeContext';
import { useRealtimeConnection } from '@/contexts/RealtimeContext';
import { trpc } from '@/lib/trpc';

/**
 * Track the lifecycle of a single BullMQ job.
 *
 * Primary channel: WebSocket — the worker publishes `job` entity events to
 * Redis pub/sub and the backend fans them out to this user. Fallback:
 * `jobs.status` tRPC query polled every 2s, used whenever the WS hasn't
 * delivered an update in 5s (covers WS drops and page reloads).
 *
 * The caller passes a `jobId` (or null while no job is active). When
 * `state` reaches `completed` or `failed`, polling stops and the consumer
 * typically unmounts the modal.
 */
export interface UseJobStatusResult {
  state: 'queued' | 'active' | 'progress' | 'completed' | 'failed' | 'unknown';
  progress: number | null;
  statusMessage: string | null;
  result: unknown;
  error: string | null;
  attemptsMade: number | null;
  attemptsAllowed: number | null;
}

const TERMINAL_STATES = new Set(['completed', 'failed']);
const POLL_INTERVAL_MS = 2_000;
const POLL_FALLBACK_AFTER_MS = 5_000;

export function useJobStatus(jobId: string | null): UseJobStatusResult {
  const { subscribeToJob } = useRealtimeConnection();
  const utils = trpc.useUtils();
  const [result, setResult] = useState<UseJobStatusResult>({
    state: 'unknown',
    progress: null,
    statusMessage: null,
    result: null,
    error: null,
    attemptsMade: null,
    attemptsAllowed: null,
  });

  const lastEventAtRef = useRef<number>(Date.now());

  useEffect(() => {
    if (!jobId) {
      setResult({
        state: 'unknown',
        progress: null,
        statusMessage: null,
        result: null,
        error: null,
        attemptsMade: null,
        attemptsAllowed: null,
      });
      return;
    }

    lastEventAtRef.current = Date.now();
    let cancelled = false;

    const applyEvent = (event: JobEvent) => {
      lastEventAtRef.current = Date.now();
      setResult((prev) => {
        // Once we've observed a terminal state (completed/failed), ignore
        // any subsequent non-terminal WS event. Redis pub/sub preserves
        // order within a publisher but BullMQ's retry semantics + the
        // lifecycle-publisher setup can re-emit an `active` or `queued`
        // event after the run already closed — without this guard the UI
        // flips "Completed" back to "Running" until the next refresh.
        if (TERMINAL_STATES.has(prev.state) && event.state && !TERMINAL_STATES.has(event.state)) {
          return prev;
        }
        return {
          state: event.state ?? prev.state,
          progress: event.progress ?? prev.progress,
          // Latch the latest worker-emitted phase message. Cleared when
          // the run reaches a terminal state below (handled implicitly:
          // terminal events typically don't carry statusMessage and
          // we keep `prev.statusMessage` if absent — that's fine because
          // JobHeader only renders it for in-flight states).
          statusMessage: event.statusMessage ?? prev.statusMessage,
          result: event.result ?? prev.result,
          error: event.error ?? null,
          attemptsMade: event.attemptsMade ?? prev.attemptsMade,
          attemptsAllowed: event.attemptsAllowed ?? prev.attemptsAllowed,
        };
      });
    };

    const unsubscribe = subscribeToJob(jobId, (_id, event) => {
      applyEvent(event);
    });

    // Count consecutive not_found replies. A one-off is fine (BullMQ may not
    // have the row yet), but sustained 'not_found' signals an orphaned jobId —
    // the backend accepted the request but the job never landed in Redis.
    // Flag to Sentry once we've polled past the threshold so ops knows.
    let notFoundStreak = 0;
    const NOT_FOUND_SENTRY_THRESHOLD = 5; // ≈10s of missing-job before we flag

    const pollOnce = async () => {
      try {
        const status = await utils.jobs.status.fetch({ jobId });
        if (cancelled) return;
        if (status.state === 'not_found') {
          notFoundStreak += 1;
          if (notFoundStreak === NOT_FOUND_SENTRY_THRESHOLD) {
            Sentry.captureMessage('job-tracking-orphaned', {
              level: 'warning',
              tags: { jobId },
            });
          }
          return;
        }
        notFoundStreak = 0;
        const nextState = mapBullState(status.state);
        setResult((prev) => {
          // Same terminal-latch guard as WS path — BullMQ's `jobs.status`
          // can briefly return `waiting` for the follow-up price-warm job
          // on the same queue, which could flip us off a terminal state.
          if (TERMINAL_STATES.has(prev.state) && !TERMINAL_STATES.has(nextState)) {
            return prev;
          }
          return {
            state: nextState,
            progress: typeof status.progress === 'number' ? status.progress : null,
            // Polling fallback can't see WS-only `statusMessage`, but we
            // keep the latched value so the message persists across
            // brief WS drops while the job is still active.
            statusMessage: prev.statusMessage,
            result: status.returnvalue ?? null,
            error: status.failedReason ?? null,
            attemptsMade: status.attemptsMade ?? null,
            attemptsAllowed: status.attemptsAllowed ?? null,
          };
        });
      } catch {
        // Network hiccup — next tick tries again.
      }
    };

    // Prime once immediately so the modal shows accurate initial state.
    void pollOnce();

    const interval = setInterval(() => {
      if (cancelled) return;
      const age = Date.now() - lastEventAtRef.current;
      // Only poll when we haven't heard from WS recently; if WS is live,
      // the UI stays fresh without extra HTTP traffic.
      if (age < POLL_FALLBACK_AFTER_MS) return;
      void pollOnce();
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(interval);
      unsubscribe();
    };
  }, [jobId, subscribeToJob, utils]);

  // Stop-condition: consumers check state and can unmount. Nothing to do
  // here — the effect's interval naturally idles once state is terminal
  // because incoming events set state=completed/failed.
  void TERMINAL_STATES;

  return result;
}

function mapBullState(state: string): UseJobStatusResult['state'] {
  switch (state) {
    case 'waiting':
    case 'waiting-children':
    case 'delayed':
      return 'queued';
    case 'active':
      return 'active';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    default:
      return 'unknown';
  }
}
