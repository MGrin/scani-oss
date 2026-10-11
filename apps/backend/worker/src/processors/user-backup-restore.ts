import { randomUUID } from 'node:crypto';
import { StorageFacade } from '@scani/cloud-client/facades/storage-facade';
import { BackupRestorer, backupRecords, RestoreRefused } from '@scani/domain/services';
import {
  BACKUP_UPLOAD_MAX_BYTES,
  PORTFOLIO_HISTORY_BACKFILL,
  PORTFOLIO_HISTORY_LOOKBACK_DAYS,
  USER_BACKUP_RESTORE,
  type UserBackupRestoreJob,
} from '@scani/jobs';
import { createComponentLogger } from '@scani/logging';
import {
  BullMqEnqueueService,
  type ProcessorContext,
  UnrecoverableError,
  UserJobProcessor,
  userFacing,
} from '@scani/queue';
import { Container, Service } from 'typedi';
import { readUpload } from '../lib/read-upload';
import { widenToEarliestWrite } from '../lib/rebuild-window';

const logger = createComponentLogger('processor:user-backup-restore');

/** At most this many differing holdings are named in the result; the count is always whole. */
const NAMED_DIFFERENCES = 20;

export interface UserBackupRestoreResult {
  rows: number;
  holdings: number;
  unmatchedTokens: number;
  balanceDifferences: number;
  differences: Array<{ holdingId: string; inFile: string; engine: string }>;
}

/**
 * Restores an uploaded backup into an empty account (SC-1649), then rebuilds
 * the account's history from the restored evidence.
 */
@Service()
export class UserBackupRestoreProcessor extends UserJobProcessor<
  UserBackupRestoreJob,
  UserBackupRestoreResult
> {
  readonly descriptor = USER_BACKUP_RESTORE;

  protected async handle(
    data: UserBackupRestoreJob,
    ctx: ProcessorContext
  ): Promise<UserBackupRestoreResult> {
    const storage = Container.get(StorageFacade);
    await ctx.reportStatus('Reading your backup…');
    const bytes = await readUpload(storage, data.r2Key, BACKUP_UPLOAD_MAX_BYTES);
    await ctx.reportStatus('Restoring your account…');
    let report: Awaited<ReturnType<BackupRestorer['restore']>>;
    try {
      report = await Container.get(BackupRestorer).restore(data.userId, () => backupRecords(bytes));
    } catch (error) {
      if (error instanceof RestoreRefused) {
        throw userFacing(new UnrecoverableError(`${error.message} Nothing was restored.`));
      }
      throw error;
    }

    await storage
      .delete(data.r2Key)
      .catch((error: unknown) =>
        logger.warn(
          { jobId: ctx.job.id, error: error instanceof Error ? error.message : String(error) },
          'The restored backup upload was not deleted; temp/ expires it'
        )
      );
    try {
      await Container.get(BullMqEnqueueService).add(PORTFOLIO_HISTORY_BACKFILL, {
        userId: data.userId,
        requestId: randomUUID(),
        tokenIds: report.tokenIds,
        lookbackDays: widenToEarliestWrite(
          PORTFOLIO_HISTORY_LOOKBACK_DAYS,
          report.earliestEvidenceAt?.toISOString() ?? null
        ),
      });
    } catch (error) {
      logger.warn(
        { jobId: ctx.job.id, error: error instanceof Error ? error.message : String(error) },
        'Failed to enqueue the history rebuild after a restore (non-fatal)'
      );
    }

    logger.info(
      {
        userId: data.userId,
        rows: Object.values(report.rows).reduce((sum, n) => sum + n, 0),
        balanceDifferences: report.balanceDifferences.length,
        unmatchedTokens: report.unmatchedTokens,
      },
      'Backup restored'
    );
    return {
      rows: Object.values(report.rows).reduce((sum, n) => sum + n, 0),
      holdings: report.rows.holdings ?? 0,
      unmatchedTokens: report.unmatchedTokens,
      balanceDifferences: report.balanceDifferences.length,
      differences: report.balanceDifferences.slice(0, NAMED_DIFFERENCES),
    };
  }
}
