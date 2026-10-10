import type { ScheduledJobStepDescriptor } from '@scani/queue';
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
// A step of the `nightly` group, after the rollup and the closed-holdings
// sweep (SC-1688).
//
// The lock makes a retry safe on top of the insert already being safe:
// the roll is an `onConflictDoNothing` upsert on `(payment_id, due_date)`,
// so a second pass over a payment inserts nothing rather than duplicating
// a due date.
export const PAYMENT_HORIZON_ROLL_SCHEDULE: ScheduledJobStepDescriptor = {
  name: JOB_NAMES.paymentHorizonRoll,
  lockName: JOB_NAMES.paymentHorizonRoll,
};
