import type { User } from '@scani/db';
import { AccountRepository, GroupRepository } from '@scani/domain/repositories';
import { AccountService, HoldingQueryService } from '@scani/domain/services';
import { BulkAssignAccountGroupsUseCase } from '@scani/domain/use-cases';
import { emitBulkEntityChanges, emitEntityChange } from '@scani/realtime';
import { IdInputDto, UpdateAccountDto } from '@scani/shared';
import { Container } from 'typedi';
import { z } from 'zod';
import { executeBulkOperation } from '../lib/bulk-operation';
import { enqueuePortfolioRollup } from '../lib/portfolio-rollup';
import { requireAuth } from '../middleware/auth';
import { protectedProcedure, router } from '../trpc';

export const accountsRouter = router({
  getAll: protectedProcedure.query(async ({ ctx }) => {
    const { dbUser } = await requireAuth(ctx);
    return await Container.get(AccountService).getAccountsByUserId(dbUser.id);
  }),

  getByUserIdWithSummary: protectedProcedure.query(async ({ ctx }) => {
    const { dbUser } = await requireAuth(ctx);
    return await Container.get(AccountService).getAccountsByUserIdWithSummary(
      dbUser.id,
      ctx.requestCache
    );
  }),

  getById: protectedProcedure.input(IdInputDto).query(async ({ input, ctx }) => {
    const { dbUser } = await requireAuth(ctx);
    return await Container.get(AccountService).getAccountById(dbUser.id, input.id);
  }),

  getHoldings: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        includeHidden: z.boolean().optional().default(false),
      })
    )
    .query(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);
      return await Container.get(HoldingQueryService).getHoldingsByAccountIdWithSummary(
        dbUser as User,
        input.id,
        input.includeHidden
      );
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        data: UpdateAccountDto,
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);

      const result = await Container.get(AccountService).updateAccount(
        input.id,
        input.data,
        dbUser.id
      );

      emitEntityChange({
        entityType: 'account',
        operationType: 'update',
        entityId: input.id,
        userId: dbUser.id,
        data: result,
      });

      return result;
    }),

  delete: protectedProcedure.input(IdInputDto).mutation(async ({ input, ctx }) => {
    const { dbUser } = await requireAuth(ctx);

    const deleted = await Container.get(AccountService).deleteAccount(input.id, dbUser.id);
    if (!deleted) {
      throw new Error('Account not found or could not be deleted');
    }

    emitEntityChange({
      entityType: 'account',
      operationType: 'delete',
      entityId: input.id,
      userId: dbUser.id,
      data: {},
    });

    // Without this, the chart keeps showing pre-deletion totals — the
    // `portfolio_value_daily` rollup still references the holdings the
    // cascade just removed. Coalesced 30s window (see helper).
    void enqueuePortfolioRollup(dbUser.id);

    return { success: true };
  }),

  bulkDelete: protectedProcedure
    .input(z.object({ ids: z.array(z.string()).min(1) }))
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);
      const accountService = Container.get(AccountService);

      const result = await executeBulkOperation(input.ids, (id) =>
        accountService.deleteAccount(id, dbUser.id)
      );

      if (result.deletedIds.length > 0) {
        emitBulkEntityChanges('account', 'delete', result.deletedIds, dbUser.id);
        void enqueuePortfolioRollup(dbUser.id);
      }

      return result;
    }),

  bulkAssignGroups: protectedProcedure
    .input(
      z.object({
        accountIds: z.array(z.string()).min(1),
        // Diff-based like `holdings.bulkAssignGroups` — see that
        // procedure for the rationale. Under the current model, an
        // account is "in" a group iff all of its visible holdings are
        // in that group. Assigning a group to an account adds that
        // group to every visible holding of the account; removing a
        // group from an account removes that group from every visible
        // holding. `accountGroups` is then recomputed as a cache.
        addedGroupIds: z.array(z.string()).default([]),
        removedGroupIds: z.array(z.string()).default([]),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);

      const result = await Container.get(BulkAssignAccountGroupsUseCase).execute(
        {
          accountIds: input.accountIds,
          addedGroupIds: input.addedGroupIds,
          removedGroupIds: input.removedGroupIds,
        },
        dbUser.id
      );

      // PERFORMANCE: Emit single bulk event instead of looping
      if (input.accountIds.length > 0) {
        emitBulkEntityChanges('account', 'update', input.accountIds, dbUser.id);
      }

      return result;
    }),

  getCommonGroups: protectedProcedure
    // Allow empty arrays — "common groups across 0 accounts" is well-
    // defined (empty set), and the frontend can transiently pass []
    // while the dialog is mounting or mid-transition. Returning []
    // is cheaper and friendlier than a 400.
    .input(z.object({ accountIds: z.array(z.string()) }))
    .query(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);

      if (input.accountIds.length === 0) return [];

      const groupRepository = Container.get(GroupRepository);
      const accountRepository = Container.get(AccountRepository);

      const userAccounts = await accountRepository.findByUser(dbUser.id);
      const userAccountIds = new Set(userAccounts.map((a) => a.id));
      const invalidAccountIds = input.accountIds.filter((id) => !userAccountIds.has(id));
      if (invalidAccountIds.length > 0) {
        throw new Error(
          `Unauthorized: Cannot access groups for accounts that don't belong to you: ${invalidAccountIds.join(
            ', '
          )}`
        );
      }

      const allAccountGroups = await Promise.all(
        input.accountIds.map((accountId) => groupRepository.findGroupsByAccountId(accountId))
      );

      if (allAccountGroups.length === 0) return [];

      return allAccountGroups.reduce(
        (common: (typeof allAccountGroups)[0], accountGroups: (typeof allAccountGroups)[0]) => {
          const accountGroupIds = new Set(accountGroups.map((g) => g.id));
          return common.filter((group) => accountGroupIds.has(group.id));
        }
      );
    }),
});
