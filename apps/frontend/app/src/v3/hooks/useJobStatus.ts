import * as Sentry from '@sentry/react';
import { useEffect, useRef, useState } from 'react';
import type { JobEvent } from '@/contexts/RealtimeContext';
import { useRealtimeConnection } from '@/contexts/RealtimeContext';
import { trpc } from '@/lib/trpc';
import {
  applyJobEvent,
  applyJobPoll,
  EMPTY_JOB_STATUS,
  JOB_STATUS_POLL_OPTIONS,
  type JobStatusSnapshot,
  jobPollIsDone,
  mapBullState,
} from '@/v3/lib/jobs';

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
const POLL_INTERVAL_MS = 2_000;
const POLL_FALLBACK_AFTER_MS = 5_000;

export function useJobStatus(jobId: string | null): JobStatusSnapshot {
  const { subscribeToJob } = useRealtimeConnection();
  const utils = trpc.useUtils();
  const [result, setResult] = useState<JobStatusSnapshot>(EMPTY_JOB_STATUS);

  const lastEventAtRef = useRef<number>(Date.now());

  useEffect(() => {
    if (!jobId) {
      setResult(EMPTY_JOB_STATUS);
      return;
    }

    lastEventAtRef.current = Date.now();
    let cancelled = false;
    let settled = false;

    const applyEvent = (event: JobEvent) => {
      lastEventAtRef.current = Date.now();
      if (jobPollIsDone('event', event.state)) settled = true;
      setResult((prev) => applyJobEvent(prev, event));
    };

    const unsubscribe = subscribeToJob(jobId, (_id, event) => {
      applyEvent(event);
    });

    // Count consecutive not_found replies. A one-off is fine (BullMQ may not
    // have the row yet), but sustained 'not_found' signals an orphaned jobId —
    // the backend accepted the request but the job never landed in the queue.
    // Flag to Sentry once we've polled past the threshold so ops knows.
    let notFoundStreak = 0;
    const NOT_FOUND_SENTRY_THRESHOLD = 5; // ≈10s of missing-job before we flag

    const pollOnce = async () => {
      try {
        const status = await utils.jobs.status.fetch({ jobId }, JOB_STATUS_POLL_OPTIONS);
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
        if (jobPollIsDone('poll', nextState)) settled = true;
        setResult((prev) => applyJobPoll(prev, status));
      } catch {
        // Network hiccup — next tick tries again.
      }
    };

    // Prime once immediately so the modal shows accurate initial state.
    void pollOnce();

    const interval = setInterval(() => {
      if (cancelled || settled) return;
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

  return result;
}
