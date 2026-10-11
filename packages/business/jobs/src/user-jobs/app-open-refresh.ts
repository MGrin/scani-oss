import type { UserJobBase, UserJobDescriptor } from '@scani/queue';
import { z } from 'zod';
import { JOB_NAMES } from '../job-names';

// The app came back to the front (SC-1602). Working out which accounts to
// re-fetch held the api's event loop for 19.4 s on production, on every
// return to the tab (SC-1671), so the request only enqueues this and the
// worker does the rest: one refresh-account-balance job per account.
export type AppOpenRefreshJob = UserJobBase;

const appOpenRefreshSchema: z.ZodType<AppOpenRefreshJob> = z.object({
  userId: z.string().min(1),
  requestId: z.string().min(1),
});

export const APP_OPEN_REFRESH: UserJobDescriptor<AppOpenRefreshJob> = {
  name: JOB_NAMES.appOpenRefresh,
  schema: appOpenRefreshSchema,
  defaultOpts: {
    attempts: 1,
    removeOnComplete: 50,
    removeOnFail: 200,
  },
  // One per user: a second open while the first is queued collapses onto it,
  // and the per-account jobs it enqueues dedupe on their own ids.
  computeJobId: (d) => [JOB_NAMES.appOpenRefresh, d.userId].join('_'),
  summarizePayload: () => ({}),
};
