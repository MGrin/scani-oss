import type { Vault } from '@scani/db/schema';
import { TokenRepository, VaultRepository } from '@scani/domain/repositories';
import { VaultService } from '@scani/domain/services';
import {
  AttachHoldingToVaultUseCase,
  DetachHoldingFromVaultUseCase,
} from '@scani/domain/use-cases';
import { emitBulkEntityChanges, emitEntityChange } from '@scani/realtime';
import {
  AttachHoldingToVaultDto,
  CreateVaultDto,
  DetachHoldingFromVaultDto,
  IdInputDto,
  UpdateVaultDto,
  UpdateVaultHoldingDto,
} from '@scani/shared';
import { Container } from 'typedi';
import { z } from 'zod';
import { executeBulkOperation } from '../lib/bulk-operation';
import { requireAuth } from '../middleware/auth';
import { protectedProcedure, router } from '../trpc';

async function deleteVault(vaultId: string, userId: string): Promise<{ success: true }> {
  const vaultRepository = Container.get(VaultRepository);
  const vault = await vaultRepository.findById(vaultId);
  if (!vault || vault.userId !== userId) {
    throw new Error('Vault not found');
  }
  await vaultRepository.delete(vaultId);
  return { success: true };
}

export const vaultsRouter = router({
  // Get all vaults for the user with progress
  getAll: protectedProcedure.query(async ({ ctx }) => {
    const { dbUser } = await requireAuth(ctx);
    return await Container.get(VaultService).getVaultsForUser(dbUser.id);
  }),

  // Get a specific vault by ID with full details
  getById: protectedProcedure.input(IdInputDto).query(async ({ input, ctx }) => {
    const { dbUser } = await requireAuth(ctx);
    const vault = await Container.get(VaultService).getVaultWithProgress(input.id);
    if (!vault || vault.userId !== dbUser.id) {
      throw new Error('Vault not found');
    }
    return vault;
  }),

  // Get vaults that a specific holding is attached to
  getByHoldingId: protectedProcedure
    .input(z.object({ holdingId: z.string().uuid() }))
    .query(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);
      const vaultRepository = Container.get(VaultRepository);
      const tokenRepository = Container.get(TokenRepository);

      const vaultRefs = await vaultRepository.findVaultsByHoldingId(input.holdingId);

      const results: Array<{
        id: string;
        name: string;
        color: string;
        percentage: number;
        currencySymbol: string;
        targetAmount: string;
        currentAmount: string;
      }> = [];
      for (const ref of vaultRefs) {
        if (ref.vault.userId !== dbUser.id) continue;
        const currency = await tokenRepository.findById(ref.vault.currencyId);
        results.push({
          id: ref.vault.id,
          name: ref.vault.name,
          color: ref.vault.color,
          percentage: ref.percentage,
          currencySymbol: currency?.symbol || '?',
          targetAmount: ref.vault.targetAmount,
          currentAmount: ref.vault.currentAmount,
        });
      }
      return results;
    }),

  // Create a new vault
  create: protectedProcedure.input(CreateVaultDto).mutation(async ({ input, ctx }) => {
    const { dbUser } = await requireAuth(ctx);
    const vaultRepository = Container.get(VaultRepository);

    let result: Vault;
    try {
      result = await vaultRepository.create({
        userId: dbUser.id,
        name: input.name,
        targetAmount: input.targetAmount,
        currencyId: input.currencyId,
        color: input.color,
        iconName: input.iconName || null,
        description: input.description || null,
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

    return result;
  }),

  // Update an existing vault
  update: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        data: UpdateVaultDto,
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);
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

      // If currency changed, recalculate vault amount
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

      return result;
    }),

  // Delete a vault
  delete: protectedProcedure.input(IdInputDto).mutation(async ({ input, ctx }) => {
    const { dbUser } = await requireAuth(ctx);

    const result = await deleteVault(input.id, dbUser.id);

    emitEntityChange({
      entityType: 'vault',
      operationType: 'delete',
      entityId: input.id,
      userId: dbUser.id,
      data: {},
    });

    return result;
  }),

  // Bulk delete vaults
  bulkDelete: protectedProcedure
    .input(z.object({ ids: z.array(z.string()).min(1) }))
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);

      const result = await executeBulkOperation(input.ids, (id) => deleteVault(id, dbUser.id));

      if (result.deletedIds.length > 0) {
        emitBulkEntityChanges('vault', 'delete', result.deletedIds, dbUser.id);
      }

      return result;
    }),

  // Attach a holding to a vault
  attachHolding: protectedProcedure
    .input(AttachHoldingToVaultDto)
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);

      const result = await Container.get(AttachHoldingToVaultUseCase).execute(input, dbUser.id);

      emitEntityChange({
        entityType: 'vault',
        operationType: 'update',
        entityId: input.vaultId,
        userId: dbUser.id,
        metadata: { holdingAttached: true, holdingId: input.holdingId },
      });

      return result;
    }),

  // Detach a holding from a vault
  detachHolding: protectedProcedure
    .input(DetachHoldingFromVaultDto)
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);

      const result = await Container.get(DetachHoldingFromVaultUseCase).execute(input, dbUser.id);

      emitEntityChange({
        entityType: 'vault',
        operationType: 'update',
        entityId: input.vaultId,
        userId: dbUser.id,
        metadata: { holdingDetached: true, holdingId: input.holdingId },
      });

      return result;
    }),

  // Update holding percentage in a vault
  updateHoldingPercentage: protectedProcedure
    .input(UpdateVaultHoldingDto)
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);
      const vaultRepository = Container.get(VaultRepository);
      const vaultService = Container.get(VaultService);

      const vault = await vaultRepository.findById(input.vaultId);
      if (!vault || vault.userId !== dbUser.id) {
        throw new Error('Vault not found');
      }

      const result = await vaultRepository.updateHoldingPercentage(
        input.vaultId,
        input.holdingId,
        input.percentage
      );
      if (!result) {
        throw new Error('Vault holding not found');
      }

      await vaultService.recalculateVaultAmount(input.vaultId);

      emitEntityChange({
        entityType: 'vault',
        operationType: 'update',
        entityId: input.vaultId,
        userId: dbUser.id,
        metadata: { percentageUpdated: true, holdingId: input.holdingId },
      });

      return result;
    }),
});
