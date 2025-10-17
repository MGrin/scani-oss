import { CreateHoldingSchema, UpdateHoldingSchema } from '@scani/shared/types';
import { Container } from 'typedi';
import { z } from 'zod';
import { PortfolioValuationService } from '../../application/services/PortfolioValuationService';
import {
  CreateHoldingUseCase,
  DeleteHoldingUseCase,
  GetHoldingsWithDetailsUseCase,
  UpdateHoldingUseCase,
} from '../../application/use-cases';
import type { HoldingRepository } from '../../infrastructure/repositories/HoldingRepository';
import { emitEntityChange } from '../../infrastructure/websocket/RealTimeUpdatesService';
import { getUserId, requireAuth } from '../../middleware/auth';
import { createComponentLogger } from '../../utils/logger';
import { protectedProcedure, router } from '../trpc';

const holdingsLogger = createComponentLogger('router:holdings');

/**
 * Factory function to create the holdings router with injected dependencies
 */
export function createHoldingsRouter(holdingRepository: HoldingRepository) {
  return router({
    // Get all holdings
    getAll: protectedProcedure.query(async ({ ctx }) => {
      const { dbUser } = requireAuth(ctx);
      const holdings = await holdingRepository.findByUser(dbUser.id);
      return holdings;
    }),

    // Get all holdings with full details (for Holdings page)
    getWithDetails: protectedProcedure.query(async ({ ctx }) => {
      const { dbUser } = requireAuth(ctx);
      const getHoldingsWithDetailsUseCase = Container.get(GetHoldingsWithDetailsUseCase);
      // No accountId - fetch all user holdings
      return await getHoldingsWithDetailsUseCase.execute(
        dbUser.id,
        dbUser.baseCurrencyId || undefined
      );
    }),

    getById: protectedProcedure
      .input(z.object({ id: z.string() }))
      .query(async ({ input, ctx }) => {
        const { dbUser } = requireAuth(ctx);
        const getHoldingsWithDetailsUseCase = Container.get(GetHoldingsWithDetailsUseCase);
        // Get all holdings with details and find the specific one
        const allHoldings = await getHoldingsWithDetailsUseCase.execute(
          dbUser.id,
          dbUser.baseCurrencyId || undefined
        );
        const holding = allHoldings.find((h) => h.id === input.id);
        return holding ?? null;
      }),

    // Check if holding already exists (for duplicate prevention)
    checkDuplicate: protectedProcedure
      .input(
        z.object({
          accountId: z.string(),
          tokenId: z.string(),
          excludeId: z.string().optional(),
        })
      )
      .query(async ({ input, ctx }) => {
        const { dbUser } = requireAuth(ctx);
        // Use repository to check for duplicates
        const holdings = await holdingRepository.findByAccount(input.accountId, dbUser.id);
        const existingHolding = holdings.find(
          (h) => h.tokenId === input.tokenId && h.id !== input.excludeId
        );

        return {
          exists: !!existingHolding,
          holding: existingHolding || null,
        };
      }),

    // Create new holding
    create: protectedProcedure
      .input(
        CreateHoldingSchema.omit({ lastUpdated: true }).extend({
          lastUpdated: z.date().optional(),
        })
      )
      .mutation(async ({ input, ctx }) => {
        const { dbUser } = requireAuth(ctx);
        const userId = dbUser.id;

        holdingsLogger.debug(
          {
            userId,
            input,
          },
          'Creating holding'
        );

        // Use CreateHoldingUseCase for business logic
        const createHoldingUseCase = Container.get(CreateHoldingUseCase);
        const result = await createHoldingUseCase.execute(
          {
            accountId: input.accountId,
            tokenId: input.tokenId,
            balance: input.balance || '0',
            lastUpdated: input.lastUpdated,
          },
          dbUser
        );

        // Emit entity change for real-time updates
        emitEntityChange({
          type: 'entity_changed',
          entityType: 'holding',
          operationType: 'create',
          entityId: result.holding.id,
          userId,
          data: {
            accountId: result.holding.accountId,
            tokenId: result.holding.tokenId,
            pricingWarning: result.priceFetchError || undefined,
          },
        });

        // Return complete holding information with pricing status
        return result;
      }),

    // Update holding
    update: protectedProcedure
      .input(
        z.object({
          id: z.string(),
          data: UpdateHoldingSchema,
        })
      )
      .mutation(async ({ input, ctx }) => {
        const userId = getUserId(ctx);

        // Use UpdateHoldingUseCase for business logic
        const updateHoldingUseCase = Container.get(UpdateHoldingUseCase);
        const updatedHolding = await updateHoldingUseCase.execute(input.id, input.data, userId);

        emitEntityChange({
          type: 'entity_changed',
          entityType: 'holding',
          operationType: 'update',
          entityId: updatedHolding.id,
          userId,
          data: {
            accountId: updatedHolding.accountId,
            tokenId: updatedHolding.tokenId,
          },
        });

        return updatedHolding;
      }),

    // Delete holding (with cascading to transactions)
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

    // Get unpriceable tokens for monetization notification
    getUnpriceableTokens: protectedProcedure.query(async ({ ctx }) => {
      const { dbUser } = requireAuth(ctx);
      const portfolioValuationService = Container.get(PortfolioValuationService);
      return await portfolioValuationService.getUnpriceableTokens(dbUser.id);
    }),
    // Note: create/update/delete endpoints contain complex transaction and pricing logic
    // that should be refactored into HoldingService in future iterations
  });
}

// Legacy export for backwards compatibility
// biome-ignore lint/suspicious/noExplicitAny: Temporary null export for backwards compatibility during migration
export const holdingsRouter = null as any;
