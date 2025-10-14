import { CreateTokenPriceSchema } from '@scani/shared/types';
import { z } from 'zod';
import type { TokenPriceRepository } from '../../infrastructure/repositories/TokenPriceRepository';
import { protectedProcedure, router } from '../trpc';

/**
 * Factory function to create the token prices router with injected dependencies
 */
export function createTokenPricesRouter(tokenPriceRepository: TokenPriceRepository) {
  return router({
    // Get all token prices
    getAll: protectedProcedure.query(async () => {
      const prices = await tokenPriceRepository.findAll();
      return prices;
    }),

    // Get prices for a specific token
    getByTokenId: protectedProcedure
      .input(z.object({ tokenId: z.string() }))
      .query(async ({ input }) => {
        // Use findAll and filter by tokenId since there's no findByToken method
        const prices = await tokenPriceRepository.findAll();
        return prices.filter((p) => p.tokenId === input.tokenId);
      }),

    // Get latest price for a token
    getLatestByTokenId: protectedProcedure
      .input(z.object({ tokenId: z.string(), baseTokenId: z.string() }))
      .query(async ({ input }) => {
        const latestPrice = await tokenPriceRepository.findLatestPrice(
          input.tokenId,
          input.baseTokenId
        );
        return latestPrice || null;
      }),

    // Get prices by date range
    getByDateRange: protectedProcedure
      .input(
        z.object({
          tokenId: z.string(),
          startDate: z.date(),
          endDate: z.date(),
          baseTokenId: z.string(),
        })
      )
      .query(async ({ input }) => {
        const prices = await tokenPriceRepository.findPriceHistory(
          input.tokenId,
          input.baseTokenId,
          input.startDate,
          input.endDate
        );
        return prices;
      }),

    // Get price at specific timestamp (or closest before)
    getPriceAtTime: protectedProcedure
      .input(
        z.object({
          tokenId: z.string(),
          timestamp: z.date(),
          baseTokenId: z.string(),
          windowMs: z.number().optional().default(60000), // 1 minute window by default
        })
      )
      .query(async ({ input }) => {
        const priceAtTime = await tokenPriceRepository.findPriceAtTimestamp(
          input.tokenId,
          input.baseTokenId,
          input.timestamp,
          input.windowMs
        );
        return priceAtTime || null;
      }),

    // Get price by ID
    getById: protectedProcedure.input(z.object({ id: z.string() })).query(async ({ input }) => {
      const tokenPrice = await tokenPriceRepository.findById(input.id);
      if (!tokenPrice) {
        throw new Error('Token price not found');
      }
      return tokenPrice;
    }),

    // Create new token price
    create: protectedProcedure.input(CreateTokenPriceSchema).mutation(async ({ input }) => {
      const tokenPriceData = {
        ...input,
        price: input.price || '0', // Ensure price is always provided as string
        createdAt: new Date(),
      };

      const createdTokenPrice = await tokenPriceRepository.create(tokenPriceData);
      if (!createdTokenPrice) {
        throw new Error('Failed to create token price');
      }

      return createdTokenPrice;
    }),

    // Bulk create token prices
    createBulk: protectedProcedure
      .input(z.array(CreateTokenPriceSchema))
      .mutation(async ({ input }) => {
        const now = new Date();
        const tokenPricesData = input.map((price) => ({
          ...price,
          price: price.price || '0', // Ensure price is always provided as string
          createdAt: now,
        }));

        const createdTokenPrices = await tokenPriceRepository.bulkUpsert(tokenPricesData);
        return createdTokenPrices;
      }),

    // Delete token price
    delete: protectedProcedure.input(z.object({ id: z.string() })).mutation(async ({ input }) => {
      const deletedTokenPrice = await tokenPriceRepository.delete(input.id);
      if (!deletedTokenPrice) {
        throw new Error('Token price not found');
      }

      return { success: true, deleted: deletedTokenPrice };
    }),

    // Delete old token prices (cleanup)
    deleteOlderThan: protectedProcedure
      .input(
        z.object({
          cutoffDate: z.date(),
          tokenId: z.string().optional(),
        })
      )
      .mutation(async ({ input }) => {
        // TokenPriceRepository doesn't have deleteOlderThan, so use findAll and delete manually
        const prices = await tokenPriceRepository.findAll();
        let deletedCount = 0;
        for (const price of prices) {
          if (
            price.timestamp <= input.cutoffDate &&
            (!input.tokenId || price.tokenId === input.tokenId)
          ) {
            await tokenPriceRepository.delete(price.id);
            deletedCount++;
          }
        }

        return {
          success: true,
          deletedCount,
        };
      }),
  });
}

// Legacy export for backwards compatibility
// biome-ignore lint/suspicious/noExplicitAny: Temporary null export for backwards compatibility during migration
export const tokenPricesRouter = null as any;
