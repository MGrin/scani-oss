import { VaultImplementations } from '@scani/core/features/implementations';
import {
  AttachHoldingToVaultDto,
  CreateVaultDto,
  DetachHoldingFromVaultDto,
  IdInputDto,
  UpdateVaultDto,
  UpdateVaultHoldingDto,
} from '@scani/shared';
import { z } from 'zod';
import {
  emitBulkEntityChanges,
  emitEntityChange,
} from '../../infrastructure/websocket/RealTimeUpdatesService';
import { requireAuth } from '../middleware/auth';
import { protectedProcedure, router } from '../trpc';

export const vaultsRouter = router({
  // Get all vaults for the user with progress
  getAll: protectedProcedure.query(async ({ ctx }) => {
    const { dbUser } = await requireAuth(ctx);
    return await VaultImplementations.getAll({ userId: dbUser.id, dbUser }, {});
  }),

  // Get a specific vault by ID with full details
  getById: protectedProcedure.input(IdInputDto).query(async ({ input, ctx }) => {
    const { dbUser } = await requireAuth(ctx);
    return await VaultImplementations.getById({ userId: dbUser.id, dbUser }, { id: input.id });
  }),

  // Get vaults that a specific holding is attached to
  getByHoldingId: protectedProcedure
    .input(z.object({ holdingId: z.string().uuid() }))
    .query(async ({ input, ctx }) => {
      const { dbUser } = await requireAuth(ctx);
      return await VaultImplementations.getByHoldingId(
        { userId: dbUser.id, dbUser },
        { holdingId: input.holdingId }
      );
    }),

  // Create a new vault
  create: protectedProcedure.input(CreateVaultDto).mutation(async ({ input, ctx }) => {
    const { dbUser } = await requireAuth(ctx);

    const result = await VaultImplementations.create({ userId: dbUser.id, dbUser }, input);

    emitEntityChange({
      type: 'entity_changed',
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

      const result = await VaultImplementations.update(
        { userId: dbUser.id, dbUser },
        { id: input.id, data: input.data }
      );

      emitEntityChange({
        type: 'entity_changed',
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

    const result = await VaultImplementations.delete(
      { userId: dbUser.id, dbUser },
      { id: input.id }
    );

    emitEntityChange({
      type: 'entity_changed',
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

      const result = await VaultImplementations.bulkDelete(
        { userId: dbUser.id, dbUser },
        { ids: input.ids }
      );

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

      const result = await VaultImplementations.attachHolding({ userId: dbUser.id, dbUser }, input);

      emitEntityChange({
        type: 'entity_changed',
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

      const result = await VaultImplementations.detachHolding({ userId: dbUser.id, dbUser }, input);

      emitEntityChange({
        type: 'entity_changed',
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

      const result = await VaultImplementations.updateHoldingPercentage(
        { userId: dbUser.id, dbUser },
        input
      );

      emitEntityChange({
        type: 'entity_changed',
        entityType: 'vault',
        operationType: 'update',
        entityId: input.vaultId,
        userId: dbUser.id,
        metadata: { percentageUpdated: true, holdingId: input.holdingId },
      });

      return result;
    }),
});
