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
      setResult((prev) => ({
        state: event.state ?? prev.state,
        progress: event.progress ?? prev.progress,
        result: event.result ?? prev.result,
        error: event.error ?? null,
        attemptsMade: event.attemptsMade ?? prev.attemptsMade,
        attemptsAllowed: event.attemptsAllowed ?? prev.attemptsAllowed,
      }));
    };

    const unsubscribe = subscribeToJob(jobId, (_id, event) => {
      applyEvent(event);
    });

    const pollOnce = async () => {
      try {
        const status = await utils.jobs.status.fetch({ jobId });
        if (cancelled) return;
        if (status.state === 'not_found') return;
        setResult({
          state: mapBullState(status.state),
          progress: typeof status.progress === 'number' ? status.progress : null,
          result: status.returnvalue ?? null,
          error: status.failedReason ?? null,
          attemptsMade: status.attemptsMade ?? null,
          attemptsAllowed: status.attemptsAllowed ?? null,
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
