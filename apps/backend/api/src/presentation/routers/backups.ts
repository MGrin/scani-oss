/**
 * Backups (SC-1649): a person asks for one, the worker writes it, and the
 * download is a short-lived signed URL minted only after the backup is proven
 * theirs. The file restores into an empty scani account.
 */
import { BackupRestorer, RESTORE_NEEDS_EMPTY, UserBackupService } from '@scani/domain/services';
import { USER_BACKUP, USER_BACKUP_RESTORE } from '@scani/jobs';
import { BullMqEnqueueService } from '@scani/queue';
import { TRPCError } from '@trpc/server';
import { Container } from 'typedi';
import { z } from 'zod';
import { USER_BUDGETS } from '../../config/limits';
import { strictInput } from '../lib/strict-input';
import { UserBudget } from '../lib/user-budget';
import { protectedProcedure, router } from '../trpc';

const backupBudget = new UserBudget({
  namespace: 'rl:backup',
  max: USER_BUDGETS.BACKUPS_PER_HOUR,
  windowMs: 60 * 60 * 1000,
});

export const backupsRouter = router({
  create: protectedProcedure
    .input(strictInput(z.object({ requestId: z.string().uuid() })))
    .mutation(async ({ ctx, input }) => {
      const budget = await backupBudget.spend(`user:${ctx.userId}`);
      if (!budget.ok) {
        throw new TRPCError({
          code: 'TOO_MANY_REQUESTS',
          message: `Too many backups; retry in ${budget.retryAfterSec}s`,
        });
      }
      const jobId = await Container.get(BullMqEnqueueService).add(USER_BACKUP, {
        userId: ctx.userId,
        requestId: input.requestId,
      });
      return { jobId };
    }),

  latest: protectedProcedure.query(async ({ ctx }) => {
    const backup = await Container.get(UserBackupService).latest(ctx.userId);
    if (!backup) return null;
    return {
      id: backup.id,
      createdAt: backup.createdAt.toISOString(),
      byteSize: backup.byteSize,
      recordCount: backup.recordCount,
    };
  }),

  /**
   * PRECONDITION_FAILED when the object is gone: `temp/` expires a backup after
   * 30 days, the row still names it, and the answer is to make a new one.
   */
  downloadUrl: protectedProcedure
    .input(strictInput(z.object({ backupId: z.string().uuid() })))
    .query(async ({ ctx, input }) => {
      const result = await Container.get(UserBackupService).presign(input.backupId, ctx.userId);
      if (result.outcome === 'not-found') {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Backup not found' });
      }
      if (result.outcome === 'expired') {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'This backup has expired. Make a new one.',
        });
      }
      return { url: result.url, expiresAt: result.expiresAt.toISOString() };
    }),

  /** Whether this account can take a restore: only an empty one can (SC-1649 Q1). */
  restorable: protectedProcedure.query(async ({ ctx }) => ({
    empty: !(await Container.get(BackupRestorer).hasData(ctx.userId)),
  })),

  /**
   * Restores an uploaded backup (`storage.getUploadUrl`, purpose `backup`).
   * The job checks emptiness again inside its transaction; this answer is so
   * a person with data hears it now rather than from a failed job.
   */
  restore: protectedProcedure
    .input(strictInput(z.object({ r2Key: z.string().min(1), requestId: z.string().uuid() })))
    .mutation(async ({ ctx, input }) => {
      if (!input.r2Key.startsWith(`temp/backup/${ctx.userId}/`)) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'That upload is not yours.' });
      }
      if (await Container.get(BackupRestorer).hasData(ctx.userId)) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: RESTORE_NEEDS_EMPTY });
      }
      const budget = await backupBudget.spend(`user:${ctx.userId}`);
      if (!budget.ok) {
        throw new TRPCError({
          code: 'TOO_MANY_REQUESTS',
          message: `Too many backups; retry in ${budget.retryAfterSec}s`,
        });
      }
      const jobId = await Container.get(BullMqEnqueueService).add(USER_BACKUP_RESTORE, {
        userId: ctx.userId,
        requestId: input.requestId,
        r2Key: input.r2Key,
      });
      return { jobId };
    }),
});
