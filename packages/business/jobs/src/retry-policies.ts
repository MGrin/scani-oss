import type { JobsOptions } from '@scani/queue';

/**
 * Named retry policies for user-initiated job descriptors.
 *
 * Until this module landed every descriptor picked its own attempts +
 * backoff numbers — exchange-import 3×10s exp, file-import 2×30s fixed,
 * screenshot-parse 2×5s exp, etc. — with no documented rationale and
 * subtle drift over time. The policies below crystallize the four
 * shapes that actually map to job semantics, so a new descriptor can
 * just pick the closest fit instead of inventing a new combination.
 *
 *   RETRY_NONE      — single attempt, no retry. For DB-transactional
 *                     jobs where a failure must propagate immediately
 *                     (manual-holdings-create, user-data-delete).
 *
 *   RETRY_FAST      — 3 attempts, 2s exponential backoff. Brief
 *                     upstream calls where transient failures resolve
 *                     within a few seconds (holding-price-update).
 *
 *   RETRY_EXTERNAL  — 3 attempts, 10s exponential backoff. External-
 *                     API-bound imports against rate-limited or flaky
 *                     upstreams (exchange-import, wallet-import).
 *
 *   RETRY_HEAVY     — 2 attempts, 30s exponential backoff. Long-running
 *                     work where re-running is expensive; defer the
 *                     retry far enough that the upstream incident likely
 *                     cleared (file-import, portfolio-history-backfill).
 *
 * Outliers (screenshot-parse, refresh-account-balance, transaction-
 * import) keep inline `attempts` / `backoff` with a per-descriptor
 * comment explaining why they don't fit one of the four named shapes.
 */

export const RETRY_NONE: Pick<JobsOptions, 'attempts'> = {
  attempts: 1,
};

export const RETRY_FAST: Pick<JobsOptions, 'attempts' | 'backoff'> = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2_000 },
};

export const RETRY_EXTERNAL: Pick<JobsOptions, 'attempts' | 'backoff'> = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 10_000 },
};

export const RETRY_HEAVY: Pick<JobsOptions, 'attempts' | 'backoff'> = {
  attempts: 2,
  backoff: { type: 'exponential', delay: 30_000 },
};
