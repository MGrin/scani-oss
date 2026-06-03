import type { User } from '@scani/db';
import { GroupRepository, TokenRepository } from '@scani/domain/repositories';
import { AccountService, HoldingQueryService, VaultService } from '@scani/domain/services';
import { DeleteHoldingUseCase, UpdateHoldingUseCase } from '@scani/domain/use-cases';
import { CreateHoldingUseCase } from '@scani/domain/use-cases/CreateHoldingUseCase';
import { emitEntityChange } from '@scani/realtime';
import { CreateHoldingDto, UpdateAccountDto, UpdateHoldingDto } from '@scani/shared';
import { Container } from 'typedi';
import { z } from 'zod';
import { withIdempotency } from '../../lib/idempotency';
import { enqueuePortfolioRollup } from '../lib/portfolio-rollup';
import { requireAuth } from '../middleware/auth';
import { MobileAccount, MobileGroup, MobileHolding, MobileVault } from '../mobile-dtos';
import { protectedProcedure, router } from '../trpc';

export const mobileRouter = router({
  accounts: protectedProcedure.output(z.array(MobileAccount)).query(async ({ ctx }) => {
    const { dbUser } = await requireAuth(ctx);
    const rows = await Container.get(AccountService).getAccountsByUserIdWithSummary(dbUser.id);
    return rows.map((a) => ({
      id: a.id,
      name: a.name,
      typeId: a.typeId,
      institutionId: a.institutionId ?? null,
      totalValue: a.summary.totalValue,
    }));
  }),

  holdings: protectedProcedure.output(z.array(MobileHolding)).query(async ({ ctx }) => {
    const { dbUser } = await requireAuth(ctx);
    const { holdings } = await Container.get(HoldingQueryService).getHoldingsByAccountIdWithSummary(
      dbUser as User,
      undefined,
      false,
      ctx.requestCache
    );
    return holdings.map((h) => ({
      id: h.id,
      accountId: h.account.id,
      symbol: h.token.symbol,
      name: h.token.name,
      amount: String(h.amount),
      value: h.value !== null ? String(h.value) : null,
    }));
  }),

  groups: protectedProcedure.output(z.array(MobileGroup)).query(async ({ ctx }) => {
    const { dbUser } = await requireAuth(ctx);
    const rows = await Container.get(GroupRepository).findByUser(dbUser.id);
    return rows.map((g) => ({
      id: g.id,
      name: g.name,
      color: g.color,
      description: g.description ?? null,
    }));
  }),

  vaults: protectedProcedure.output(z.array(MobileVault)).query(async ({ ctx }) => {
    const { dbUser } = await requireAuth(ctx);
    const rows = await Container.get(VaultService).getVaultsForUser(dbUser.id);
    return rows.map((v) => ({
      id: v.id,
      name: v.name,
      targetAmount: String(v.targetAmount),
      currentAmount: String(v.currentAmount),
      currencyId: v.currencyId,
      color: v.color,
      iconName: v.iconName ?? null,
      description: v.description ?? null,
    }));
  }),

  updateAccount: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        data: UpdateAccountDto,
        idempotencyKey: z.string().min(1).max(128).optional(),
      })
    )
    .output(MobileAccount)
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);
      return withIdempotency(dbUser.id, input.idempotencyKey, async () => {
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

        return {
          id: result.id,
          name: result.name,
          typeId: result.typeId,
          institutionId: result.institutionId ?? null,
          totalValue: '0',
        };
      });
    }),

  deleteAccount: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        idempotencyKey: z.string().min(1).max(128).optional(),
      })
    )
    .output(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);
      return withIdempotency(dbUser.id, input.idempotencyKey, async () => {
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

        void enqueuePortfolioRollup(dbUser.id);
        return { id: input.id };
      });
    }),

  createHolding: protectedProcedure
    .input(
      z.object({
        data: CreateHoldingDto,
        idempotencyKey: z.string().min(1).max(128).optional(),
      })
    )
    .output(MobileHolding)
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);
      return withIdempotency(dbUser.id, input.idempotencyKey, async () => {
        const { holding } = await Container.get(CreateHoldingUseCase).execute(
          input.data,
          dbUser as User
        );

        const token = await Container.get(TokenRepository).findById(holding.tokenId);

        emitEntityChange({
          entityType: 'holding',
          operationType: 'create',
          entityId: holding.id,
          userId: dbUser.id,
          data: {
            accountId: holding.accountId,
            tokenId: holding.tokenId,
          },
        });

        void enqueuePortfolioRollup(dbUser.id);

        return {
          id: holding.id,
          accountId: holding.accountId,
          symbol: token?.symbol ?? '',
          name: token?.name ?? '',
          amount: holding.balance,
          value: null,
        };
      });
    }),

  updateHolding: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        data: UpdateHoldingDto,
        idempotencyKey: z.string().min(1).max(128).optional(),
      })
    )
    .output(MobileHolding)
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);
      return withIdempotency(dbUser.id, input.idempotencyKey, async () => {
        const updatedHolding = await Container.get(UpdateHoldingUseCase).execute(
          input.id,
          input.data,
          dbUser.id,
          { baseCurrencyId: dbUser.baseCurrencyId || undefined }
        );

        const token = await Container.get(TokenRepository).findById(updatedHolding.tokenId);

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

        return {
          id: updatedHolding.id,
          accountId: updatedHolding.accountId,
          symbol: token?.symbol ?? '',
          name: token?.name ?? '',
          amount: updatedHolding.balance,
          value: null,
        };
      });
    }),

  deleteHolding: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        idempotencyKey: z.string().min(1).max(128).optional(),
      })
    )
    .output(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);
      return withIdempotency(dbUser.id, input.idempotencyKey, async () => {
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
        return { id: input.id };
      });
    }),
});
