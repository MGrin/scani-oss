import type { ScheduledJobDescriptor } from '@scani/queue';
import { JOB_NAMES } from '../job-names';

// One digest a week, Monday 08:00 UTC (SC-460).
//
// **Monday after the Sunday-night chain, not before it.** The digest quotes
// `portfolio_value_daily` and computes its movers from the same table, which
// the nightly rollup fills at 04:00 after the 03:00/03:30/03:45 backfills feed
// it. Firing earlier would mail Saturday's figure and call it this week's.
//
// **:00 rather than a quieter-looking minute.** The hourly jobs already wake
// the database on the hour and the quarter-hour probes cluster on :00/:15/:30/
// :45 so their advisory locks batch into one wake and Neon can scale to zero
// between them. A cron at :07 would buy nothing and cost an extra wake.
//
// The advisory lock is what makes two overlapping fires no-op rather than
// double-send. It does NOT make a retry safe on its own — a run that mailed
// half the recipients and then threw takes the lock cleanly on the retry — so
// `users.digest_last_sent_at` carries the rest of that guarantee (see
// `DIGEST_COOLDOWN_MS`).
export const WEEKLY_DIGEST_SCHEDULE: ScheduledJobDescriptor = {
  name: JOB_NAMES.weeklyDigest,
  cron: '0 8 * * 1',
  lockName: JOB_NAMES.weeklyDigest,
};
