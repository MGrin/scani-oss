import type { ScheduledJobDescriptor } from '@scani/queue';
import { JOB_NAMES } from '../job-names';

// Bounded sweep: pages `holding_transactions WHERE counterparty IS NULL
// AND raw_payload IS NOT NULL` (~1850 rows on first run, then just the
// day's new arrivals). Nightly, after the transfer-linking step of the
// 03:00-05:00 chain, ahead of the quarter-hour reconcilers.
export const BACKFILL_COUNTERPARTY_SCHEDULE: ScheduledJobDescriptor = {
  name: JOB_NAMES.backfillCounterparty,
  cron: '30 5 * * *',
  lockName: JOB_NAMES.backfillCounterparty,
};
