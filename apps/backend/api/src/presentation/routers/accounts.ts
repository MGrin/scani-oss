import { AccountRepository, GroupRepository } from '@scani/domain/repositories';
import { AccountService } from '@scani/domain/services';
import { BulkAssignAccountGroupsUseCase } from '@scani/domain/use-cases';
import { emitBulkEntityChanges, emitEntityChange } from '@scani/realtime';
import { IdInputDto, UpdateAccountDto } from '@scani/shared';
import { Container } from 'typedi';
import { z } from 'zod';
import { executeBulkOperation } from '../lib/bulk-operation';
import { enqueuePortfolioRollup } from '../lib/portfolio-rollup';
import { strictInput } from '../lib/strict-input';
import { requireAuth } from '../middleware/auth';
import { protectedProcedure, router } from '../trpc';

export const accountsRouter = router({
  getAll: protectedProcedure.query(async ({ ctx }) => {
    const { dbUser } = await requireAuth(ctx);
    return await Container.get(AccountService).getAccountsByUserId(dbUser.id);
  }),

  getByUserIdWithSummary: protectedProcedure.query(async ({ ctx }) => {
    const { dbUser } = await requireAuth(ctx);
    return await Container.get(AccountService).getAccountsByUserIdWithSummary(dbUser.id);
  }),

  getById: protectedProcedure.input(strictInput(IdInputDto)).query(async ({ input, ctx }) => {
    const { dbUser } = await requireAuth(ctx);
    return await Container.get(AccountService).getAccountById(dbUser.id, input.id);
  }),

  update: protectedProcedure
    .input(
      strictInput(
        z.object({
          id: z.string().uuid(),
          data: UpdateAccountDto,
        })
      )
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

  delete: protectedProcedure.input(strictInput(IdInputDto)).mutation(async ({ input, ctx }) => {
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
    .input(strictInput(z.object({ ids: z.array(z.string()).min(1) })))
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
      strictInput(
        z.object({
          // Bounded so a buggy or hostile client can't request a
          // multi-thousand-row mutation in one round-trip.
          accountIds: z.array(z.string()).min(1).max(200),
          // Diff-based like `holdings.bulkAssignGroups` — see that
          // procedure for the rationale. An account in a group is a
          // STANDING RULE (SC-386): everything it holds now and receives
          // later is in the group, until a single holding is vetoed out
          // of it. Adding writes `account_groups` alone; removing also
          // drops the holdings' own rows, so "not in this group" is
          // total.
          addedGroupIds: z.array(z.string()).max(50).default([]),
          removedGroupIds: z.array(z.string()).max(50).default([]),
        })
      )
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
    .input(strictInput(z.object({ accountIds: z.array(z.string()).max(200) })))
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
