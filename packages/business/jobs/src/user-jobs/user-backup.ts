import type { UserJobBase, UserJobDescriptor } from '@scani/queue';
import { z } from 'zod';
import { JOB_NAMES } from '../job-names';

export type UserBackupJob = UserJobBase;

const userBackupSchema: z.ZodType<UserBackupJob> = z.object({
  userId: z.string().min(1),
  requestId: z.string().min(1),
});

const JOB_ID_SEP = '_';

/**
 * A backup of one account (SC-1649): every backed-up row, gzipped NDJSON,
 * stored under `temp/backup/<userId>/`. It only reads the account, so a retry
 * is safe; the second attempt writes a fresh object and supersedes the first.
 */
export const USER_BACKUP: UserJobDescriptor<UserBackupJob> = {
  name: JOB_NAMES.userBackup,
  schema: userBackupSchema,
  defaultOpts: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 30_000 },
    removeOnComplete: 100,
    removeOnFail: 500,
  },
  computeJobId: (d) => [JOB_NAMES.userBackup, d.userId, d.requestId].join(JOB_ID_SEP),
  summarizePayload: () => ({}),
};
