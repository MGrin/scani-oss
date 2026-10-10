import { BackupTooLargeError, UserBackupService } from '@scani/domain/services';
import { USER_BACKUP, type UserBackupJob } from '@scani/jobs';
import {
  type ProcessorContext,
  UnrecoverableError,
  UserJobProcessor,
  userFacing,
} from '@scani/queue';
import { Container, Service } from 'typedi';

export interface UserBackupResult {
  backupId: string;
  byteSize: number;
  recordCount: number;
  counts: Record<string, number>;
}

/** Builds and stores a person's backup (SC-1649); the result names it for the download. */
@Service()
export class UserBackupProcessor extends UserJobProcessor<UserBackupJob, UserBackupResult> {
  readonly descriptor = USER_BACKUP;

  protected async handle(data: UserBackupJob, ctx: ProcessorContext): Promise<UserBackupResult> {
    await ctx.reportStatus('Writing your backup…');
    try {
      const backup = await Container.get(UserBackupService).create(data.userId);
      return {
        backupId: backup.id,
        byteSize: backup.byteSize,
        recordCount: backup.recordCount,
        counts: backup.counts,
      };
    } catch (error) {
      if (error instanceof BackupTooLargeError) {
        throw userFacing(
          new UnrecoverableError(
            'Your backup is larger than a backup can be today. Nothing was stored. Please contact support.'
          )
        );
      }
      throw error;
    }
  }
}
