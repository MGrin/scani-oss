import type { User } from '@scani/db';
import {
  AccountRepository,
  AccountTypeRepository,
  GroupRepository,
  HoldingApyConfigRepository,
  HoldingRepository,
} from '@scani/domain/repositories';
import { HoldingQueryService, HoldingService } from '@scani/domain/services';
import {
  BulkAssignHoldingGroupsUseCase,
  DeleteHoldingUseCase,
  UpdateHoldingUseCase,
} from '@scani/domain/use-cases';
import { HOLDING_PRICE_UPDATE, REFRESH_ACCOUNT_BALANCE } from '@scani/jobs';
import { BullMqEnqueueService } from '@scani/queue';
import { emitBulkEntityChanges, emitEntityChange } from '@scani/realtime';
import { UpdateHoldingDto, UpsertHoldingApyConfigDto } from '@scani/shared';
import { TRPCError } from '@trpc/server';
import { Container } from 'typedi';
import { z } from 'zod';
import { executeBulkOperation } from '../lib/bulk-operation';
import { enqueuePortfolioRollup } from '../lib/portfolio-rollup';
import { requireAuth } from '../middleware/auth';
import { protectedProcedure, router } from '../trpc';

export const holdingsRouter = router({
  // Get all holdings with full details (for Holdings page)
  getWithDetails: protectedProcedure.query(async ({ ctx }) => {
    const { dbUser } = await requireAuth(ctx);
    return await Container.get(HoldingQueryService).getHoldingsByAccountIdWithSummary(
      dbUser as User,
      undefined,
      false,
      ctx.requestCache
    );
  }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        data: UpdateHoldingDto,
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);

      const updatedHolding = await Container.get(UpdateHoldingUseCase).execute(
        input.id,
        input.data,
        dbUser.id,
        { baseCurrencyId: dbUser.baseCurrencyId || undefined }
      );

      emitEntityChange({
        entityType: 'holding',
        operationType: 'update',
        entityId: updatedHolding.id,
        userId: dbUser.id,
        data: {
          accountId: updatedHolding.accountId,
          tokenId: updatedHolding.tokenId,
        },
      });

      void enqueuePortfolioRollup(dbUser.id);
      return updatedHolding;
    }),

  // Delete holding (with cascading to transactions)
  delete: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);

      const result = await Container.get(DeleteHoldingUseCase).execute(input.id, dbUser.id, {
        baseCurrencyId: dbUser.baseCurrencyId || undefined,
      });

      emitEntityChange({
        entityType: 'holding',
        operationType: 'delete',
        entityId: result.deleted.id,
        userId: dbUser.id,
        metadata: {
          relatedEntities: [
            {
              type: 'account',
              id: result.deleted.accountId,
            },
          ],
        },
      });

      void enqueuePortfolioRollup(dbUser.id);
      return result;
    }),

  bulkDelete: protectedProcedure
    .input(z.object({ ids: z.array(z.string()).min(1) }))
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);
      const useCase = Container.get(DeleteHoldingUseCase);
      const baseCurrencyId = dbUser.baseCurrencyId || undefined;

      const result = await executeBulkOperation(input.ids, (id) =>
        useCase.execute(id, dbUser.id, { baseCurrencyId })
      );

      // PERFORMANCE: Emit single bulk event instead of looping
      if (result.deletedIds.length > 0) {
        emitBulkEntityChanges('holding', 'delete', result.deletedIds, dbUser.id);
        void enqueuePortfolioRollup(dbUser.id);
      }

      return result;
    }),

  // Restore a hidden holding (unmark as hidden)
  restore: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);

      const holdingRepository = Container.get(HoldingRepository);
      const holdingService = Container.get(HoldingService);
      const holding = await holdingRepository.findById(input.id);
      if (!holding) throw new Error('Holding not found');
      if (holding.userId !== dbUser.id) {
        throw new Error('Unauthorized: Holding does not belong to user');
      }
      if (!holding.isHidden) throw new Error('Holding is not hidden');
      const result = await holdingService.unhideHoldingWithEvent(input.id);
      if (!result) throw new Error('Failed to restore holding');

      emitEntityChange({
        entityType: 'holding',
        operationType: 'update',
        entityId: result.id,
        userId: dbUser.id,
        data: {
          accountId: result.accountId,
          tokenId: result.tokenId,
        },
      });

      void enqueuePortfolioRollup(dbUser.id);
      return result;
    }),

  /**
   * Enqueue a holding price refresh. Fetches fresh price from pricing
   * providers (1–3s), then cascades to vault recalculation on the worker.
   * Returns a jobId for the UI to track.
   */
  updatePrice: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        requestId: z.string().uuid(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);
      const jobId = await Container.get(BullMqEnqueueService).add(HOLDING_PRICE_UPDATE, {
        userId: dbUser.id,
        requestId: input.requestId,
        holdingId: input.id,
        // The worker fetches fresh price from providers; these fields are
        // placeholders for a future manual-override payload.
        priceUsd: 0,
        priceSource: 'fetch',
      });
      return { jobId };
    }),

  // Per-holding "Refresh balance" trigger. Looks up the holding, finds
  // the underlying account, and enqueues a balance refresh that hits
  // the same chain / CEX / brokerage provider the hourly cron does.
  // Manual-source holdings have no integration to refresh — the
  // endpoint rejects them with PRECONDITION_FAILED so the frontend can
  // surface a clean "edit the balance manually" message instead of
  // queuing a no-op job. The job's BullMQ id is per-(user, account)
  // so a flurry of clicks collapses to one in-flight refresh.
  refreshBalance: protectedProcedure
    .input(
      z.object({
        holdingId: z.string().uuid(),
        requestId: z.string().uuid(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);
      const holdingRepo = Container.get(HoldingRepository);
      const holding = await holdingRepo.findById(input.holdingId);
      if (!holding || holding.userId !== dbUser.id) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Holding not found' });
      }
      if (!holding.source || holding.source === 'manual') {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message:
            'This holding is manual — edit the balance directly. Refresh is only for wallet / exchange / broker holdings.',
        });
      }
      const jobId = await Container.get(BullMqEnqueueService).add(REFRESH_ACCOUNT_BALANCE, {
        userId: dbUser.id,
        requestId: input.requestId,
        holdingId: holding.id,
        accountId: holding.accountId,
      });
      return { jobId };
    }),

  bulkAssignGroups: protectedProcedure
    .input(
      z.object({
        // 500 is well above any realistic UI selection — the bulk-edit
        // grid maxes around the visible viewport — but bounded so a
        // hostile or buggy client can't request a multi-thousand-row
        // database operation in a single round-trip.
        holdingIds: z.array(z.string()).min(1).max(500),
        // The dialog computes an explicit diff between the pre-checked
        // common-groups state and the user's save selection, then sends
        // add/remove sets. Preferable to REPLACE semantics because
        // REPLACE would clobber any per-holding groups that weren't in
        // the pre-checked set.
        addedGroupIds: z.array(z.string()).max(50).default([]),
        removedGroupIds: z.array(z.string()).max(50).default([]),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);

      const result = await Container.get(BulkAssignHoldingGroupsUseCase).execute(
        {
          holdingIds: input.holdingIds,
          addedGroupIds: input.addedGroupIds,
          removedGroupIds: input.removedGroupIds,
        },
        dbUser.id
      );

      // PERFORMANCE: Emit single bulk event instead of looping
      if (input.holdingIds.length > 0) {
        emitBulkEntityChanges('holding', 'update', input.holdingIds, dbUser.id);
      }

      return result;
    }),

  getCommonGroups: protectedProcedure
    // Allow empty arrays — "common groups across 0 holdings" is well-
    // defined (empty set), and the frontend can transiently pass []
    // while the dialog is mounting or mid-transition. Returning []
    // is cheaper and friendlier than a 400.
    .input(z.object({ holdingIds: z.array(z.string()).max(500) }))
    .query(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);

      if (input.holdingIds.length === 0) return [];

      // Single batch query that joins through holdings + filters by
      // user_id. Replaces N sequential findGroupsByHoldingId calls
      // (one DB roundtrip per holding) plus the pre-flight
      // findByUserWithFullDetails (5-table join just for ownership
      // validation). For 100 holdings this dropped from ~101 DB
      // roundtrips to 2 (1 batch + 1 ownership backfill for owned
      // holdings with zero groups).
      const groupRepository = Container.get(GroupRepository);
      const groupsMap = await groupRepository.findGroupsByHoldingIds(dbUser.id, input.holdingIds);
      const invalidHoldingIds = input.holdingIds.filter((id) => !groupsMap.has(id));
      if (invalidHoldingIds.length > 0) {
        throw new Error(
          `Unauthorized: Cannot access groups for holdings that don't belong to you: ${invalidHoldingIds.join(
            ', '
          )}`
        );
      }

      // Intersect the per-holding group lists.
      const perHolding = input.holdingIds.map((id) => groupsMap.get(id) ?? []);
      if (perHolding.length === 0) return [];
      return perHolding.reduce((common, holdingGroups) => {
        const holdingGroupIds = new Set(holdingGroups.map((g) => g.id));
        return common.filter((group) => holdingGroupIds.has(group.id));
      });
    }),

  // APY Config endpoints
  getApyConfig: protectedProcedure
    .input(z.object({ holdingId: z.string().uuid() }))
    .query(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);
      const holdingRepository = Container.get(HoldingRepository);
      const apyConfigRepository = Container.get(HoldingApyConfigRepository);
      const holding = await holdingRepository.findByIdVisible(input.holdingId);
      if (!holding || holding.userId !== dbUser.id) throw new Error('Holding not found');
      return await apyConfigRepository.findByHoldingId(input.holdingId);
    }),

  upsertApyConfig: protectedProcedure
    .input(UpsertHoldingApyConfigDto)
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);

      const holdingRepository = Container.get(HoldingRepository);
      const accountRepository = Container.get(AccountRepository);
      const accountTypeRepository = Container.get(AccountTypeRepository);
      const apyConfigRepository = Container.get(HoldingApyConfigRepository);
      const holding = await holdingRepository.findByIdVisible(input.holdingId);
      if (!holding || holding.userId !== dbUser.id) throw new Error('Holding not found');

      const account = await accountRepository.findById(holding.accountId);
      if (!account) throw new Error('Account not found');
      const accountType = await accountTypeRepository.findById(account.typeId);
      if (!accountType || !['checking', 'savings', 'investment'].includes(accountType.code)) {
        throw new Error(
          'APY configuration is only available for checking, savings, and investment accounts'
        );
      }

      const result = await apyConfigRepository.upsertByHoldingId(input.holdingId, {
        annualRatePct: input.annualRatePct,
        payoutFrequency: input.payoutFrequency,
        payoutDayOfWeek: input.payoutDayOfWeek ?? null,
        payoutDayOfMonth: input.payoutDayOfMonth ?? null,
        payoutMonth: input.payoutMonth ?? null,
      });

      emitEntityChange({
        entityType: 'holding',
        operationType: 'update',
        entityId: input.holdingId,
        userId: dbUser.id,
      });

      return result;
    }),

  deleteApyConfig: protectedProcedure
    .input(z.object({ holdingId: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);

      const holdingRepository = Container.get(HoldingRepository);
      const apyConfigRepository = Container.get(HoldingApyConfigRepository);
      const holding = await holdingRepository.findByIdVisible(input.holdingId);
      if (!holding || holding.userId !== dbUser.id) throw new Error('Holding not found');
      const result = await apyConfigRepository.deleteByHoldingId(input.holdingId);

      emitEntityChange({
        entityType: 'holding',
        operationType: 'update',
        entityId: input.holdingId,
        userId: dbUser.id,
      });

      return result;
    }),
});
