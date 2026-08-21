import type { ScheduledJobDescriptor } from '@scani/queue';
import { JOB_NAMES } from '../job-names';

/**
 * Puts the demo instance back to its seed, once a day (SC-466).
 *
 * **Deliberately absent from `SCHEDULED_JOB_DESCRIPTORS`.** The worker adds it
 * only when `SCANI_DEMO_MODE=1`, and in that case it adds *nothing else* — see
 * `apps/backend/worker/src/index.ts`. Every other schedule is wrong for a demo:
 * the hourly pricing job would overwrite the seeded `token_prices` series with
 * real quotes and take the dataset's determinism with it, the balance syncs
 * would try to reach chains and exchanges for accounts that do not exist, and
 * the nightly rollup would recompute `portfolio_value_daily` over invented
 * transactions. A demo that drifts between resets is a demo that is wrong for
 * most of the day.
 *
 * 06:00 UTC: after the last of the nightly chain (`backfill-counterparty`,
 * 05:30) and before `alert-sweep` at 09:00, so the hour is free on a normal
 * deployment too — this file has to state a time that is defensible whether or
 * not it is the only job running. On the hour, like every other fixed-minute
 * schedule here: the advisory locks batch into one database wake and Neon
 * scales back to zero between them, and a job at :07 buys nothing.
 *
 * Locked on its own name. Two resets running at once would each delete the
 * demo user out from under the other's inserts.
 */
export const DEMO_RESET_SCHEDULE: ScheduledJobDescriptor = {
  name: JOB_NAMES.demoReset,
  cron: '0 6 * * *',
  lockName: JOB_NAMES.demoReset,
};
