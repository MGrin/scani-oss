import { describeJobFailure, isReviewableJobName } from '@scani/shared';

/**
 * The jobs list's pure half — what a job's state is called, whether it is still
 * waiting on the user, and the one line of payload a row can carry.
 *
 * v2 splits the list into four `Card` sections (Needs your review / Active /
 * Completed / Failed) built by four `filter` calls. v3 keeps the same four
 * buckets but makes them a **filter dimension and a group-by** on one list,
 * because that is what they are: four static sections mean three of them are
 * empty most of the time, and the one that matters — "needs your review" —
 * only leads while it is non-empty. As a filter option it is reachable at any
 * time, and the default grouping still floats it to the top.
 */

/** The fields the list's own logic reads off a `jobs.listMine` row. */
export interface JobRow {
  jobId: string;
  jobName: string;
  state: string;
  createdAt: string | Date;
  actionTakenAt?: string | Date | null;
  payloadSummary?: unknown;
  /** The failure half of the row (SC-153). `state === 'failed'` alone cannot
   *  separate a retry that is coming from one that never will, and the list is
   *  where that distinction is worth the most — it is the screen someone opens
   *  to find out whether their import is still going. */
  deadAt?: string | Date | null;
  failureReason?: string | null;
  attemptsMade?: number | null;
  attemptsAllowed?: number | null;
}

/** BullMQ's own states, in the order a run moves through them. */
const STATE_LABELS: Record<string, string> = {
  queued: 'Queued',
  active: 'Active',
  progress: 'Running',
  completed: 'Completed',
  failed: 'Failed',
};

export function jobStateLabel(state: string): string {
  return STATE_LABELS[state] ?? state;
}

const RUNNING_STATES = new Set(['queued', 'active', 'progress']);

export function isJobRunning(job: JobRow): boolean {
  return RUNNING_STATES.has(job.state);
}

/**
 * A finished job whose result the user still has to confirm before its
 * holdings count toward the portfolio. `REVIEWABLE_JOB_NAMES` in
 * `@scani/shared` is the single list of which job names have that follow-up,
 * shared with the server's own review feed so the two cannot disagree.
 */
export function jobNeedsAction(job: JobRow): boolean {
  return job.state === 'completed' && isReviewableJobName(job.jobName) && !job.actionTakenAt;
}

/**
 * The four buckets, as one value per job. This is both the group-by key and
 * the filter value, so a job cannot be in "Needs your review" for one and
 * "Completed" for the other — which is exactly what v2's two independent
 * `filter` calls allow (a pending job appears in both its sections).
 */
export type JobBucket = 'review' | 'running' | 'completed' | 'failed';

export function jobBucket(job: JobRow): JobBucket {
  if (jobNeedsAction(job)) return 'review';
  if (isJobRunning(job)) return 'running';
  // A job whose last attempt failed but whose next one is already queued is
  // running, whatever the row says. Filing it under Failed puts a job that
  // needs nothing from anyone in the section people open when something is
  // wrong, and — the half that matters — leaves the section unable to mean
  // "these are dead" (SC-153).
  if (describeJobFailure(job)?.willRetry) return 'running';
  return job.state === 'failed' ? 'failed' : 'completed';
}

interface BucketDef {
  key: JobBucket;
  label: string;
}

/** Ordered by urgency, which is the order the group headings appear in. */
export const JOB_BUCKETS: readonly BucketDef[] = [
  { key: 'review', label: 'Needs your review' },
  { key: 'running', label: 'Running' },
  { key: 'failed', label: "Failed — won't retry" },
  { key: 'completed', label: 'Completed' },
];

export function jobBucketLabel(bucket: JobBucket): string {
  return JOB_BUCKETS.find((entry) => entry.key === bucket)?.label ?? bucket;
}

/**
 * Bucket options for the filter sheet, restricted to the buckets actually
 * present. An option that can only ever produce the filtered-empty screen is a
 * control that lies about what the list contains.
 */
export function jobBucketOptions(jobs: readonly JobRow[]): { value: string; label: string }[] {
  const present = new Set(jobs.map(jobBucket));
  return JOB_BUCKETS.filter((entry) => present.has(entry.key)).map((entry) => ({
    value: entry.key,
    label: entry.label,
  }));
}

function time(value: string | Date): number {
  return typeof value === 'string' ? new Date(value).getTime() : value.getTime();
}

export function compareJobs(a: JobRow, b: JobRow, field: string, direction: string): number {
  const mult = direction === 'asc' ? 1 : -1;
  switch (field) {
    case 'started':
      return (time(a.createdAt) - time(b.createdAt)) * mult;
    case 'state':
      return jobStateLabel(a.state).localeCompare(jobStateLabel(b.state)) * mult;
    default:
      return 0;
  }
}

/**
 * The state to *show*, given what the run actually produced.
 *
 * BullMQ says "completed" when the worker returned without throwing, even if
 * every per-file outcome inside the result failed — a screenshot parse that
 * extracted zero holdings, a manual create where every price fetch errored. A
 * green "Completed" chip above a red failure body is the mismatch users
 * reported, so the chip reads the result. The framework state is left alone for
 * everything still running and for results we cannot introspect.
 *
 * Only the chip uses this. The body still renders on the framework state,
 * because it has to show the result as soon as the worker finishes regardless
 * of what is in it.
 */
export function deriveJobOutcomeState(jobName: string, state: string, result: unknown): string {
  if (state !== 'completed' || !result || typeof result !== 'object') return state;
  const record = result as Record<string, unknown>;

  if (jobName === 'screenshot-parse' || jobName === 'file-import') {
    const summary = (record.summary ?? {}) as Record<string, unknown>;
    const successes = Number(summary.successCount ?? 0);
    const failures = Number(summary.failureCount ?? 0);
    if (successes === 0 && failures > 0) return 'failed';
  }

  if (jobName === 'manual-holdings-create') {
    const holdings = Array.isArray(record.holdings) ? record.holdings : [];
    if (
      holdings.length > 0 &&
      holdings.every((holding) => Boolean((holding as Record<string, unknown>).error))
    ) {
      return 'failed';
    }
  }

  return state;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/**
 * The one identifying line a row can carry about *what* the job was pointed at
 * — a chain and address, a file count, an exchange name.
 *
 * A string rather than v2's `<JobSummary>` element: on a `<DataRow>` this is
 * the sublabel, which truncates, and the row's own `aria-label` has to be able
 * to say it. Field names track the backend's sanitised `payload_summary`.
 */
export function summariseJobPayload(jobName: string, payloadSummary: unknown): string | null {
  const summary = asRecord(payloadSummary);
  switch (jobName) {
    case 'wallet-import': {
      const parts = [summary.chain, summary.address, summary.label]
        .filter((part): part is string => typeof part === 'string' && part.length > 0)
        .join(' · ');
      return parts || null;
    }
    case 'screenshot-parse': {
      const count = Number(summary.fileCount ?? 0);
      return Number.isFinite(count) && count > 0 ? `${count} file${count === 1 ? '' : 's'}` : null;
    }
    case 'exchange-import':
      return typeof summary.provider === 'string' ? summary.provider : null;
    case 'file-import': {
      const type = typeof summary.fileType === 'string' ? summary.fileType : 'file';
      return summary.enrich ? `${type} · enriched` : type;
    }
    case 'holding-price-update':
      return 'Holding price refresh';
    case 'user-data-delete':
      return 'Delete all account data';
    default:
      return null;
  }
}
