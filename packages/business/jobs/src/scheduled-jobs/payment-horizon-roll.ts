import type { ScheduledJobDescriptor } from '@scani/queue';
import { JOB_NAMES } from '../job-names';

// Advances the forward edge of every active payment's materialised
// schedule (SC-622). Until this existed nothing did: occurrences are
// filled twelve months past the day a payment was last WRITTEN, so an
// untouched payment lost a month of its own future every month and every
// long-horizon read tapered toward zero.
//
// Daily, because the thing it repairs moves one day per day and the
// window it maintains is a year wide — an hourly cadence would find
// nothing to do on 23 of 24 fires. Missing a night costs a day of edge on
// a 365-day horizon, so this is the one nightly job with nothing
// depending on it having run.
//
// 04:45 UTC: after the rollup (04:00) and the closed-holdings sweep
// (04:30), before the counterparty backfill (05:30), and quarter-hour
// aligned like the rest so the advisory locks batch into one wake and
// Neon can scale to zero between them.
//
// The lock makes a retry safe on top of the insert already being safe:
// the roll is an `onConflictDoNothing` upsert on `(payment_id, due_date)`,
// so a second pass over a payment inserts nothing rather than duplicating
// a due date.
export const PAYMENT_HORIZON_ROLL_SCHEDULE: ScheduledJobDescriptor = {
  name: JOB_NAMES.paymentHorizonRoll,
  cron: '45 4 * * *',
  lockName: JOB_NAMES.paymentHorizonRoll,
};
