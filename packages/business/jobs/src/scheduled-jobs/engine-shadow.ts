import type { ScheduledJobDescriptor } from '@scani/queue';
import { JOB_NAMES } from '../job-names';

// Foundation A1's nightly shadow (D-10): the new engine's balances and prices
// beside today's, every difference stored with its cause in
// `engine_shadow_differences`. It writes only its report tables, plus any
// exchange rate the live price resolver fetches into `token_prices`, as a
// dashboard read does. Removed at the flip (A5).
//
// Runs at 05:45, after the nightly chain (historical-price-backfill 03:00,
// forex 03:30, transfer-linking 03:45, portfolio-value-rollup 04:00) and the
// 05:00 token-price downsample have finished writing, so it compares the day's
// settled state; on the quarter hour, like the other wakes. The advisory lock
// keeps two machines from running it at once. A failed attempt is retried
// (the scheduler's default attempts), and a retry runs only the kinds no
// earlier attempt recorded (`EngineShadowProcessor`).
export const ENGINE_SHADOW_SCHEDULE: ScheduledJobDescriptor = {
  name: JOB_NAMES.engineShadow,
  cron: '45 5 * * *',
  lockName: JOB_NAMES.engineShadow,
};
