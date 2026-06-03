import type { User } from '@scani/db';
import { GroupRepository, TokenRepository, VaultRepository } from '@scani/domain/repositories';
import { AccountService, HoldingQueryService, VaultService } from '@scani/domain/services';
import { DeleteHoldingUseCase, UpdateHoldingUseCase } from '@scani/domain/use-cases';
import { CreateHoldingUseCase } from '@scani/domain/use-cases/CreateHoldingUseCase';
import { emitEntityChange } from '@scani/realtime';
import {
  CreateHoldingDto,
  UpdateAccountDto,
  UpdateGroupDto,
  UpdateHoldingDto,
  UpdateVaultDto,
} from '@scani/shared';
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

  createGroup: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1).max(50),
        color: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
        description: z.string().max(200).nullish(),
        idempotencyKey: z.string().min(1).max(128).optional(),
      })
    )
    .output(MobileGroup)
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);
      return withIdempotency(dbUser.id, input.idempotencyKey, async () => {
        const groupRepository = Container.get(GroupRepository);
        let result: Awaited<ReturnType<typeof groupRepository.create>>;
        try {
          result = await groupRepository.create({
            userId: dbUser.id,
            name: input.name,
            color: input.color,
            description: input.description ?? null,
            displayOrder: 0,
            isActive: true,
          });
        } catch (error) {
          if (
            error instanceof Error &&
            ((error as unknown as { code: string }).code === '23505' ||
              error.message.includes('unique constraint') ||
              error.message.includes('duplicate key') ||
              error.message.includes('uniqueUserGroupName'))
          ) {
            throw new Error(`A group with the name "${input.name}" already exists`);
          }
          throw error;
        }

        emitEntityChange({
          entityType: 'group',
          operationType: 'create',
          entityId: result.id,
          userId: dbUser.id,
          data: result as Record<string, unknown>,
        });

        return {
          id: result.id,
          name: result.name,
          color: result.color,
          description: result.description ?? null,
        };
      });
    }),

  updateGroup: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        data: UpdateGroupDto,
        idempotencyKey: z.string().min(1).max(128).optional(),
      })
    )
    .output(MobileGroup)
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);
      return withIdempotency(dbUser.id, input.idempotencyKey, async () => {
        const groupRepository = Container.get(GroupRepository);
        const group = await groupRepository.findById(input.id);
        if (!group || group.userId !== dbUser.id) {
          throw new Error('Unauthorized access to group');
        }
        const result = await groupRepository.update(input.id, input.data);
        if (!result) {
          throw new Error('Group not found');
        }

        emitEntityChange({
          entityType: 'group',
          operationType: 'update',
          entityId: input.id,
          userId: dbUser.id,
          data: result as Record<string, unknown>,
        });

        return {
          id: result.id,
          name: result.name,
          color: result.color,
          description: result.description ?? null,
        };
      });
    }),

  deleteGroup: protectedProcedure
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
        const groupRepository = Container.get(GroupRepository);
        const group = await groupRepository.findById(input.id);
        if (!group || group.userId !== dbUser.id) {
          throw new Error('Unauthorized access to group');
        }
        await groupRepository.delete(input.id);

        emitEntityChange({
          entityType: 'group',
          operationType: 'delete',
          entityId: input.id,
          userId: dbUser.id,
          data: {},
        });

        return { id: input.id };
      });
    }),

  createVault: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1).max(100),
        targetAmount: z.string().min(1),
        currencyId: z.string().uuid(),
        color: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
        iconName: z.string().max(50).nullish(),
        description: z.string().max(500).nullish(),
        idempotencyKey: z.string().min(1).max(128).optional(),
      })
    )
    .output(MobileVault)
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);
      return withIdempotency(dbUser.id, input.idempotencyKey, async () => {
        const vaultRepository = Container.get(VaultRepository);
        let result: Awaited<ReturnType<typeof vaultRepository.create>>;
        try {
          result = await vaultRepository.create({
            userId: dbUser.id,
            name: input.name,
            targetAmount: input.targetAmount,
            currencyId: input.currencyId,
            color: input.color,
            iconName: input.iconName ?? null,
            description: input.description ?? null,
            currentAmount: '0',
            isActive: true,
          });
        } catch (error) {
          if (
            error instanceof Error &&
            ((error as unknown as { code: string }).code === '23505' ||
              error.message.includes('unique constraint') ||
              error.message.includes('duplicate key') ||
              error.message.includes('uniqueUserVaultName'))
          ) {
            throw new Error(`A vault with the name "${input.name}" already exists`);
          }
          throw error;
        }

        emitEntityChange({
          entityType: 'vault',
          operationType: 'create',
          entityId: result.id,
          userId: dbUser.id,
          data: result as Record<string, unknown>,
        });

        return {
          id: result.id,
          name: result.name,
          targetAmount: String(result.targetAmount),
          currentAmount: String(result.currentAmount),
          currencyId: result.currencyId,
          color: result.color,
          iconName: result.iconName ?? null,
          description: result.description ?? null,
        };
      });
    }),

  updateVault: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        data: UpdateVaultDto,
        idempotencyKey: z.string().min(1).max(128).optional(),
      })
    )
    .output(MobileVault)
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);
      return withIdempotency(dbUser.id, input.idempotencyKey, async () => {
        const vaultRepository = Container.get(VaultRepository);
        const vaultService = Container.get(VaultService);
        const vault = await vaultRepository.findById(input.id);
        if (!vault || vault.userId !== dbUser.id) {
          throw new Error('Vault not found');
        }

        const result = await vaultRepository.update(input.id, {
          ...input.data,
          updatedAt: new Date(),
        });
        if (!result) {
          throw new Error('Vault not found');
        }

        if (input.data.currencyId && input.data.currencyId !== vault.currencyId) {
          await vaultService.recalculateVaultAmount(input.id);
        }

        emitEntityChange({
          entityType: 'vault',
          operationType: 'update',
          entityId: input.id,
          userId: dbUser.id,
          data: result as Record<string, unknown>,
        });

        return {
          id: result.id,
          name: result.name,
          targetAmount: String(result.targetAmount),
          currentAmount: String(result.currentAmount),
          currencyId: result.currencyId,
          color: result.color,
          iconName: result.iconName ?? null,
          description: result.description ?? null,
        };
      });
    }),

  deleteVault: protectedProcedure
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
        const vaultRepository = Container.get(VaultRepository);
        const vault = await vaultRepository.findById(input.id);
        if (!vault || vault.userId !== dbUser.id) {
          throw new Error('Vault not found');
        }
        await vaultRepository.delete(input.id);

        emitEntityChange({
          entityType: 'vault',
          operationType: 'delete',
          entityId: input.id,
          userId: dbUser.id,
          data: {},
        });

        return { id: input.id };
      });
    }),
});
