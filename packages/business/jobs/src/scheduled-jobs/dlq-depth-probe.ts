import type { ScheduledJobDescriptor } from '@scani/queue';
import { JOB_NAMES } from '../job-names';

// Dead-letter sweeper. Every 15 minutes the worker reads `scani-dlq`, removes
// what has aged out, escalates each entry once on its arrival, and escalates
// the depth when it crosses a threshold. Nothing consumes that queue, so
// without this a terminal failure sits there unseen and for ever (SC-1545).
// The advisory lock keeps two machines from double-firing an alert when both
// run a probe at the same minute — and it's exactly why this probe is on the
// shared quarter-hour cadence: the PG advisory lock wakes Neon, so all
// frequent jobs fire together and the DB sleeps in between.
export const DLQ_DEPTH_PROBE_SCHEDULE: ScheduledJobDescriptor = {
  name: JOB_NAMES.dlqDepthProbe,
  cron: '*/15 * * * *',
  lockName: JOB_NAMES.dlqDepthProbe,
};

/**
 * The alarm a dead letter is open under in `operator_alarms`, keyed by its id.
 * Part of the stored contract, like `STALE_SYNC_ALARM`: renaming it re-escalates
 * every open entry at once.
 */
export const DEAD_LETTER_ALARM = 'dead-letter';

/** Same bound and same reasoning as `STALE_SYNC_RENOTIFY_MS`: one untriaged entry is restated weekly. */
export const DEAD_LETTER_RENOTIFY_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How long a dead letter is kept. The queue is for the post-mortem of a recent
 * failure, and an entry holds the failed job's whole payload, so one nobody
 * acted on in two weeks is removed rather than archived.
 */
export const DEAD_LETTER_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * How long a `failed` row stays on the main queue. `removeOnFail` keeps them by
 * COUNT, which at this queue's failure rate is years, and a failed row carries
 * the job's payload too.
 */
export const FAILED_JOB_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
