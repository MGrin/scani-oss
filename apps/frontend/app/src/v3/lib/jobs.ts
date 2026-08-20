import { describeJobFailure, isReviewableJobName, type JobFailureDescription } from '@scani/shared';
import type { TFunction } from 'i18next';

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
const STATE_KEYS: Record<string, string> = {
  queued: 'v3.jobs.state.queued',
  active: 'v3.jobs.state.active',
  progress: 'v3.jobs.state.progress',
  completed: 'v3.jobs.state.completed',
  failed: 'v3.jobs.state.failed',
};

/**
 * A state a *reader* can read. The framework's own vocabulary is not it: these
 * five arrive as `completed` / `failed` and were rendered by a hardcoded
 * English table, so the job detail header said "Completed" over an otherwise
 * Russian page (SC-421).
 *
 * The fallback is the raw state rather than a key, because BullMQ can emit one
 * we have no word for (`stalled`) and a bare `v3.jobs.state.stalled` on screen
 * is worse than the state's own name.
 */
export function jobStateLabel(t: TFunction, state: string): string {
  const key = STATE_KEYS[state];
  return key ? t(key) : state;
}

/**
 * The failure, named (SC-424).
 *
 * `describeJobFailure` answers with a code and its operands because it lives in
 * `@scani/shared`, which the API and the worker import and which therefore has
 * no `t()`. This is the naming half, and it is why the chip beside a Russian
 * "Завершена" no longer reads "Failed — won't retry".
 *
 * Both halves take the same `description` so a chip and the sentence under it
 * cannot describe different failures — the property SC-153 bought and the one
 * worth keeping through a refactor of the return type.
 *
 * `t` is narrowed to what these two actually call rather than to i18next's
 * `TFunction`, for the same reason `ReviewTexts.t` in `review-text.ts` is:
 * the review feed composes a dead job's line through the same naming, and
 * passes the `t` it was handed rather than an i18next instance.
 */
export type JobFailureTranslate = (key: string, vars?: Record<string, unknown>) => string;

export function jobFailureLabel(
  t: JobFailureTranslate,
  description: JobFailureDescription
): string {
  if (description.code === 'retrying') {
    return t('v3.jobs.failure.retrying.label', {
      made: description.attemptsMade,
      allowed: description.attemptsAllowed,
    });
  }
  return t(`v3.jobs.failure.${description.code}.label`);
}

export function jobFailureSentence(
  t: JobFailureTranslate,
  description: JobFailureDescription
): string {
  switch (description.code) {
    case 'retrying':
      return t('v3.jobs.failure.retrying.sentence', {
        made: description.attemptsMade,
        allowed: description.attemptsAllowed,
      });
    case 'exhausted':
      // `count`, not a plain operand: "tried 2 times" and "tried 5 times" are
      // different words in Russian, and this is the one sentence here that
      // interpolates a number into a noun phrase.
      return t('v3.jobs.failure.exhausted.sentence', { count: description.attemptsAllowed });
    default:
      return t(`v3.jobs.failure.${description.code}.sentence`);
  }
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
  labelKey: string;
}

/** Ordered by urgency, which is the order the group headings appear in. */
export const JOB_BUCKETS: readonly BucketDef[] = [
  { key: 'review', labelKey: 'v3.jobs.bucket.review' },
  { key: 'running', labelKey: 'v3.jobs.bucket.running' },
  { key: 'failed', labelKey: 'v3.jobs.bucket.failed' },
  { key: 'completed', labelKey: 'v3.jobs.bucket.completed' },
];

export function jobBucketLabel(t: TFunction, bucket: JobBucket): string {
  const found = JOB_BUCKETS.find((entry) => entry.key === bucket);
  return found ? t(found.labelKey) : bucket;
}

/**
 * Bucket options for the filter sheet, restricted to the buckets actually
 * present. An option that can only ever produce the filtered-empty screen is a
 * control that lies about what the list contains.
 */
export function jobBucketOptions(
  t: TFunction,
  jobs: readonly JobRow[]
): { value: string; label: string }[] {
  const present = new Set(jobs.map(jobBucket));
  return JOB_BUCKETS.filter((entry) => present.has(entry.key)).map((entry) => ({
    value: entry.key,
    label: t(entry.labelKey),
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
export function summariseJobPayload(
  t: TFunction,
  jobName: string,
  payloadSummary: unknown
): string | null {
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
      return Number.isFinite(count) && count > 0 ? t('v3.jobs.fileCount', { count }) : null;
    }
    case 'exchange-import':
      return typeof summary.provider === 'string' ? summary.provider : null;
    case 'file-import': {
      const type =
        typeof summary.fileType === 'string' ? summary.fileType : t('v3.jobs.kind.fileFallback');
      return summary.enrich ? t('v3.jobs.kind.fileEnriched', { type }) : type;
    }
    case 'holding-price-update':
      return t('v3.jobs.kind.holdingPriceRefresh');
    case 'user-data-delete':
      return t('v3.jobs.kind.deleteAllData');
    default:
      return null;
  }
}
