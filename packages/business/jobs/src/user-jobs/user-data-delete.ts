import type { UserJobBase, UserJobDescriptor } from '@scani/queue';
import { z } from 'zod';
import { JOB_NAMES } from '../job-names';

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
    // Destructive: do not retry on failure — surface the error.
    attempts: 1,
    removeOnComplete: 100,
    removeOnFail: 500,
  },
  computeJobId: (d) => [JOB_NAMES.userDataDelete, d.userId, d.requestId].join(JOB_ID_SEP),
  summarizePayload: () => ({}),
};
