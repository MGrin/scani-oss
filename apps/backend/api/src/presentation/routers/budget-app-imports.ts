/**
 * Imports from a budget app (SC-1649). The browser reads the register's
 * account names, the person maps each one, and the worker re-reads the file
 * and lands every row in one transaction. Undo removes one upload's rows.
 */
import { BudgetAppImportService } from '@scani/domain/services';
import { BUDGET_APP_IMPORT, BUDGET_APP_IMPORT_UNDO } from '@scani/jobs';
import { BullMqEnqueueService } from '@scani/queue';
import { TRPCError } from '@trpc/server';
import { Container } from 'typedi';
import { z } from 'zod';
import { strictInput } from '../lib/strict-input';
import { protectedProcedure, router } from '../trpc';

const target = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('new'), typeCode: z.string().min(1).max(64) }),
  z.object({ kind: z.literal('existing'), accountId: z.string().uuid() }),
  z.object({ kind: z.literal('skip') }),
]);

export const budgetAppImportsRouter = router({
  /**
   * The person's accounts, each saying whether it can take an import. A
   * provider, a wallet or a live sync already books an account's movements,
   * so importing into it would count them twice.
   */
  targets: protectedProcedure.query(({ ctx }) =>
    Container.get(BudgetAppImportService).importTargets(ctx.userId)
  ),

  list: protectedProcedure.query(async ({ ctx }) => {
    const imports = await Container.get(BudgetAppImportService).listImports(ctx.userId);
    return imports.map((record) => ({
      id: record.id,
      app: record.app,
      createdAt: record.createdAt.toISOString(),
      undoneAt: record.undoneAt?.toISOString() ?? null,
      accounts: record.summary.accounts.filter((a) => a.accountId !== null).length,
      rows: record.summary.accounts.reduce((n, a) => n + a.rowsInserted, 0),
    }));
  }),

  /** Queues the import of the caller's own uploaded register (purpose `file-import`). */
  start: protectedProcedure
    .input(
      strictInput(
        z.object({
          r2Key: z.string().min(1),
          requestId: z.string().uuid(),
          app: z.enum(['ynab', 'actual', 'mint']),
          currency: z.string().min(2).max(12),
          dateOrder: z.enum(['day-first', 'month-first']).optional(),
          accounts: z
            .array(z.object({ name: z.string().min(1).max(200), target }))
            .min(1)
            .max(200),
        })
      )
    )
    .mutation(async ({ ctx, input }) => {
      if (!input.r2Key.startsWith(`temp/file-import/${ctx.userId}/`)) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'That upload is not yours.' });
      }
      if (input.accounts.every((a) => a.target.kind === 'skip')) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Choose at least one account.' });
      }
      const existing = input.accounts.flatMap((a) =>
        a.target.kind === 'existing' ? [a.target.accountId] : []
      );
      if (new Set(existing).size !== existing.length) {
        // Two of the file's accounts into one would share its feed input and its row keys.
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Import each account into a different scani account.',
        });
      }
      const jobId = await Container.get(BullMqEnqueueService).add(BUDGET_APP_IMPORT, {
        userId: ctx.userId,
        requestId: input.requestId,
        r2Key: input.r2Key,
        app: input.app,
        currency: input.currency,
        ...(input.dateOrder ? { dateOrder: input.dateOrder } : {}),
        accounts: input.accounts,
      });
      return { jobId };
    }),

  /** The worker scopes the undo to the caller, so another person's id finds nothing. */
  undo: protectedProcedure
    .input(strictInput(z.object({ importId: z.string().uuid(), requestId: z.string().uuid() })))
    .mutation(async ({ ctx, input }) => {
      const jobId = await Container.get(BullMqEnqueueService).add(BUDGET_APP_IMPORT_UNDO, {
        userId: ctx.userId,
        requestId: input.requestId,
        importId: input.importId,
      });
      return { jobId };
    }),
});
