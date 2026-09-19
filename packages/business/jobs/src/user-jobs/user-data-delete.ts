import type { UserJobBase, UserJobDescriptor } from '@scani/queue';
import { z } from 'zod';
import { JOB_NAMES } from '../job-names';
import { RETRY_NONE } from '../retry-policies';

export type UserDataDeleteJob = UserJobBase & {
  /** Also remove the login and the `users` row, not only the data (SC-1276). */
  deleteAccount?: boolean;
};

export const userDataDeleteSchema: z.ZodType<UserDataDeleteJob> = z.object({
  userId: z.string().min(1),
  requestId: z.string().min(1),
  deleteAccount: z.boolean().optional(),
});

const JOB_ID_SEP = '_';

export const USER_DATA_DELETE: UserJobDescriptor<UserDataDeleteJob> = {
  name: JOB_NAMES.userDataDelete,
  schema: userDataDeleteSchema,
  defaultOpts: {
    // Destructive: RETRY_NONE so a failure surfaces immediately
    // rather than getting auto-replayed against partially-deleted data.
    ...RETRY_NONE,
    removeOnComplete: 100,
    removeOnFail: 500,
  },
  computeJobId: (d) => [JOB_NAMES.userDataDelete, d.userId, d.requestId].join(JOB_ID_SEP),
  // The only field recorded: it is how the next sign-in finds an account
  // deletion that did not finish (SC-1276).
  summarizePayload: (d) => (d.deleteAccount ? { deleteAccount: true } : {}),
};
