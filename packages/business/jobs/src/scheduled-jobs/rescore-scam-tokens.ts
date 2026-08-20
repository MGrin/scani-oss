import type { ScheduledJobDescriptor } from '@scani/queue';
import { JOB_NAMES } from '../job-names';

// SC-286. `is_scam_probability` is written once, at token creation, and never
// recomputed — so every improvement to the heuristic applied to tokens created
***REMOVED***
***REMOVED***
***REMOVED***
//
// Daily, not hourly, and deliberately so. The trigger for work is a developer
// bumping `SCAM_SCORE_VERSION` in a deploy — an event measured in months, not
// minutes — so a faster cadence buys nothing and costs a Neon wake. On a run
// where nothing changed this is one indexed predicate that matches no rows:
// no name reads, no writes, no `updated_at` churn.
//
// 02:30 UTC keeps it clear of the 03:00-05:00 nightly chain (historical prices,
// forex, rollup, transfer linking), which is where the DB's night is already
// spoken for.
export const RESCORE_SCAM_TOKENS_SCHEDULE: ScheduledJobDescriptor = {
  name: JOB_NAMES.rescoreScamTokens,
  cron: '30 2 * * *',
  lockName: JOB_NAMES.rescoreScamTokens,
};
