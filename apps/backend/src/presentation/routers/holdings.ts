import { UpdateHoldingDto } from '@scani/shared';
import { Container } from 'typedi';
import { z } from 'zod';
import { HoldingService } from '../../application/services/HoldingService';
import { DeleteHoldingUseCase, UpdateHoldingUseCase, UpdateHoldingPriceUseCase } from '../../application/use-cases';
import { emitEntityChange } from '../../infrastructure/websocket/RealTimeUpdatesService';
import { TokenRepository } from '../../infrastructure/repositories/TokenRepository';
import { requireAuth } from '../middleware/auth';
import { protectedProcedure, router } from '../trpc';

const holdingService = Container.get(HoldingService);
const tokenRepository = Container.get(TokenRepository);

export const holdingsRouter = router({
  // Get all holdings with full details (for Holdings page)
  // Keep
  getWithDetails: protectedProcedure.query(async ({ ctx }) => {
    const { dbUser } = requireAuth(ctx);
    const holdingsWithDetails = await holdingService.getHoldingsByAccountIdWithDetails(dbUser);
    return holdingsWithDetails;
  }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        data: UpdateHoldingDto,
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = requireAuth(ctx);

      // Use UpdateHoldingUseCase for business logic
      const updateHoldingUseCase = Container.get(UpdateHoldingUseCase);
      const updatedHolding = await updateHoldingUseCase.execute(input.id, input.data, dbUser.id);

      emitEntityChange({
        type: 'entity_changed',
        entityType: 'holding',
        operationType: 'update',
        entityId: updatedHolding.id,
        userId: dbUser.id,
        data: {
          accountId: updatedHolding.accountId,
          tokenId: updatedHolding.tokenId,
        },
      });

      return updatedHolding;
    }),

  // Delete holding (with cascading to transactions)
  // KEEP
  delete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = requireAuth(ctx);

      // Use DeleteHoldingUseCase for business logic
      const deleteHoldingUseCase = Container.get(DeleteHoldingUseCase);
      const result = await deleteHoldingUseCase.execute(input.id, dbUser.id);

      emitEntityChange({
        type: 'entity_changed',
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

      return result;
    }),

  // Update holding price by forcing fresh fetch from pricing providers
  updatePrice: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const { dbUser } = requireAuth(ctx);

      // Use UpdateHoldingPriceUseCase for business logic
      const updateHoldingPriceUseCase = Container.get(UpdateHoldingPriceUseCase);
      
      // Get user's base currency
      const baseCurrency = dbUser.baseCurrencyId 
        ? (await tokenRepository.findById(dbUser.baseCurrencyId))?.symbol || 'USD'
        : 'USD';

      const result = await updateHoldingPriceUseCase.execute(input.id, dbUser.id, baseCurrency);

      // Emit entity change event to trigger real-time updates
      emitEntityChange({
        type: 'entity_changed',
        entityType: 'holding',
        operationType: 'update',
        entityId: input.id,
        userId: dbUser.id,
      });

      return result;
    }),
});
