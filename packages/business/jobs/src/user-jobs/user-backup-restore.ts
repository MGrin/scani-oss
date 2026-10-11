import type { UserJobBase, UserJobDescriptor } from '@scani/queue';
import { z } from 'zod';
import { JOB_NAMES } from '../job-names';

export interface UserBackupRestoreJob extends UserJobBase {
  /** The uploaded backup, under `temp/backup/<userId>/`. */
  r2Key: string;
}

const userBackupRestoreSchema: z.ZodType<UserBackupRestoreJob> = z.object({
  userId: z.string().min(1),
  requestId: z.string().min(1),
  r2Key: z.string().min(1),
});

const JOB_ID_SEP = '_';

/**
 * Restores a backup into an empty account (SC-1649). It writes in one
 * transaction, so a failed attempt leaves nothing behind and a retry starts
 * clean; a refusal (not a backup, an account with data) ends the job at once.
 */
export const USER_BACKUP_RESTORE: UserJobDescriptor<UserBackupRestoreJob> = {
  name: JOB_NAMES.userBackupRestore,
  schema: userBackupRestoreSchema,
  defaultOpts: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 30_000 },
    removeOnComplete: 100,
    removeOnFail: 500,
  },
  computeJobId: (d) => [JOB_NAMES.userBackupRestore, d.userId, d.requestId].join(JOB_ID_SEP),
  summarizePayload: () => ({}),
};
