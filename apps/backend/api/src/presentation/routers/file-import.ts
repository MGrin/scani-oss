/**
 * File import router
 * Handles bank statement file import, asynchronously on the worker
 */

import { AccountRepository } from '@scani/domain/repositories';
import { FILE_IMPORT } from '@scani/jobs';
import { createComponentLogger } from '@scani/logging';
import { BullMqEnqueueService } from '@scani/queue';
import { TRPCError } from '@trpc/server';
import { Container } from 'typedi';
import { z } from 'zod';
import { strictInput } from '../lib/strict-input';
import { protectedProcedure, router } from '../trpc';

const fileImportLogger = createComponentLogger('router:file-import');

export const fileImportRouter = router({
  /**
   * Parse + enrich a bank statement asynchronously.
   *
   * The client uploads the file to R2 via `storage.getUploadUrl` and then
   * calls this mutation with the returned `r2Key`. Enrichment (token
   * lookup + existing-holdings match) can take several seconds on large
   * CSVs, so it now runs on the worker. Returns a jobId for the UI to
   * track via WebSocket / jobs.status.
   */
  parseAndEnrich: protectedProcedure
    .input(
      strictInput(
        z.object({
          r2Key: z.string().min(1),
          // The presigned key is a uuid; without the real name the Files
          // list can only show `a1b2c3.csv`.
          originalFilename: z.string().min(1).max(512).optional(),
          fileType: z.enum(['csv', 'ofx', 'qif']).default('csv'),
          accountId: z.string().min(1, 'accountId is required'),
          requestId: z.string().uuid(),
          // Forwarded to the file-import worker as a fallback when the
          // file has no Currency column. Set by the picker UI on the
          // failed first-attempt's job-detail page.
          defaultCurrency: z.string().min(1).max(8).optional(),
        })
      )
    )
    .mutation(async ({ input, ctx }) => {
      // Enforce that the R2 key belongs to the caller. Without this, a
      // leaked key from another user (logs, client telemetry, replay)
      // could be submitted here and the worker would fetch that user's
      // file and import it into the attacker's account. Keys from
      // `storage.getUploadUrl` are always scoped to
      // `temp/file-import/{userId}/...`.
      const expectedPrefix = `temp/file-import/${ctx.userId}/`;
      if (!input.r2Key.startsWith(expectedPrefix) || input.r2Key.includes('..')) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Upload key does not belong to the current user',
        });
      }
      // Enforce that the target account belongs to the caller. The
      // worker forwards `accountId` straight into the ingest pipeline;
      // without a router-side check, an attacker could pair their own
      // r2Key with a victim's accountId and pollute the victim's
      // transactions / holdings ledger.
      const account = await Container.get(AccountRepository).findByIdAndUser(
        input.accountId,
        ctx.userId
      );
      if (!account) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Account does not belong to the current user',
        });
      }
      fileImportLogger.info(
        {
          userId: ctx.userId,
          accountId: input.accountId,
          r2Key: input.r2Key,
          requestId: input.requestId,
        },
        'Enqueuing file-import job'
      );
      const jobId = await Container.get(BullMqEnqueueService).add(FILE_IMPORT, {
        userId: ctx.userId,
        requestId: input.requestId,
        r2Key: input.r2Key,
        originalFilename: input.originalFilename,
        fileType: input.fileType,
        accountId: input.accountId,
        enrich: true,
        defaultCurrency: input.defaultCurrency,
      });
      return { jobId };
    }),
});
