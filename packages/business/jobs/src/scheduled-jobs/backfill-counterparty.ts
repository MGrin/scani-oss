import type { ScheduledJobStepDescriptor } from '@scani/queue';
import { JOB_NAMES } from '../job-names';

// Bounded sweep: pages `holding_transactions WHERE counterparty IS NULL
// AND raw_payload IS NOT NULL` (~1850 rows on first run, then just the
// day's new arrivals). A step of the `nightly` group, after transfer-linking.
export const BACKFILL_COUNTERPARTY_SCHEDULE: ScheduledJobStepDescriptor = {
  name: JOB_NAMES.backfillCounterparty,
  lockName: JOB_NAMES.backfillCounterparty,
};
