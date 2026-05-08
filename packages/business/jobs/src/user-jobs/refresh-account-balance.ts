import type { UserJobBase, UserJobDescriptor } from '@scani/queue';
import { z } from 'zod';
import { JOB_NAMES } from '../job-names';

// Per-account balance refresh, queued by the user clicking "Refresh
// balance" on a holding. Mirrors HOLDING_PRICE_UPDATE shape but scopes
// to one account so dedup happens by (user, account) — clicking
// twice in quick succession collapses to one in-flight job rather
// than stacking.
export interface RefreshAccountBalanceJob extends UserJobBase {
  /** The holding the button was clicked on (for routing back to the UI). */
  holdingId: string;
  /** The account whose balance should be re-fetched. */
  accountId: string;
}

export const refreshAccountBalanceSchema: z.ZodType<RefreshAccountBalanceJob> = z.object({
  userId: z.string().min(1),
  requestId: z.string().min(1),
  holdingId: z.string().min(1),
  accountId: z.string().min(1),
});

const JOB_ID_SEP = '_';

export const REFRESH_ACCOUNT_BALANCE: UserJobDescriptor<RefreshAccountBalanceJob> = {
  name: JOB_NAMES.refreshAccountBalance,
  schema: refreshAccountBalanceSchema,
  defaultOpts: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 5_000 },
    removeOnComplete: 50,
    removeOnFail: 200,
  },
  // Per-(user, accountId) dedup key. requestId is intentionally NOT
  // part of the id so a second click on the same account collapses
  // onto the in-flight job. The api-side `recomputeHistory` flow uses
  // the same pattern (UserJobRepository.findInFlightByName).
  computeJobId: (d) => [JOB_NAMES.refreshAccountBalance, d.userId, d.accountId].join(JOB_ID_SEP),
  summarizePayload: (d) => ({ holdingId: d.holdingId, accountId: d.accountId }),
};
