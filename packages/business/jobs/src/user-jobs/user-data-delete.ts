import type { UserJobBase, UserJobDescriptor } from '@scani/queue';
import { z } from 'zod';
import { JOB_NAMES } from '../job-names';
import { RETRY_NONE } from '../retry-policies';

export type UserDataDeleteJob = UserJobBase;

export const userDataDeleteSchema: z.ZodType<UserDataDeleteJob> = z.object({
  userId: z.string().min(1),
  requestId: z.string().min(1),
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
  summarizePayload: () => ({}),
};
