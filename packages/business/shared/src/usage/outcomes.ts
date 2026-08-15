/**
 * The vocabulary of `cloud_usage_events.outcome`, and the one place that
 * decides whether a value in it is a failure.
 *
 * The column is free text with no check constraint, and the dashboard used to
 * read it as "an error is anything that is not `ok`". That is a denylist of
 * exactly one string: a single unrecognised value — a hand-seeded row, a
 * legacy spelling, a writer that says `success` — turns *every* request into
 * an error, and the console shows a healthy account 100% (SC-76). The failure
 * side is the closed set, so this is an allowlist instead: a value we do not
 * recognise is not evidence that a request failed, and undercounting an
 * unknown beats reporting a total outage that is not happening.
 *
 * It lives in the frontend-safe contract package because the readers do not
 * share a backend: the writer and the paid console's `/usage` are in
 * `data-provider`, while the admin dashboard's 24h tile queries the same table
 * straight from Next.js. Every one of them imports this module, so they cannot
 * drift — admin's own copy of the question, spelled `!= 'success'`, made its
 * tile read 100% for the same reason the console's did (SC-79).
 */

export const USAGE_SUCCESS_OUTCOME = 'ok' as const;

/** Every outcome that means the caller did not get what they asked for. */
export const USAGE_FAILURE_OUTCOMES = [
  'error',
  'rate_limited',
  'unauthorized',
  'quota_exceeded',
] as const;

export const USAGE_OUTCOMES = [USAGE_SUCCESS_OUTCOME, ...USAGE_FAILURE_OUTCOMES] as const;

export type UsageOutcome = (typeof USAGE_OUTCOMES)[number];

const FAILURES: ReadonlySet<string> = new Set(USAGE_FAILURE_OUTCOMES);

/** Takes a `string` rather than a `UsageOutcome`: rows come back from Postgres
 *  as text, and the whole point is to be right about values the union does not
 *  cover. */
export function isUsageFailure(outcome: string): boolean {
  return FAILURES.has(outcome);
}

export interface OutcomeTally {
  outcome: string;
  count: number;
}

export interface UsageOutcomeSummary {
  totalRequests: number;
  errors: number;
  /** `0` on an empty window rather than `NaN` — a window with no traffic has
   *  no error rate, and `NaN` renders as a placeholder the reader reads as a
   *  fault in the dashboard. */
  errorRate: number;
}

/**
 * Folds `group by outcome` counts into the summary tile's three figures.
 *
 * Pure and exported so the arithmetic behind "Error rate" is pinned by a
 * fixture rather than by looking at a chart: both of this bug's symptoms —
 * 100.00%, and an error series drawn at exactly the height of the request
 * series — are shapes a chart renders perfectly happily.
 */
export function summarizeOutcomes(rows: readonly OutcomeTally[]): UsageOutcomeSummary {
  let totalRequests = 0;
  let errors = 0;
  for (const row of rows) {
    totalRequests += row.count;
    if (isUsageFailure(row.outcome)) errors += row.count;
  }
  return {
    totalRequests,
    errors,
    errorRate: totalRequests === 0 ? 0 : errors / totalRequests,
  };
}
