import { CreateTokenPriceSchema } from '@scani/shared/types';
import { and, desc, eq, gte, lte } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { db } from '../db/connection';
import * as schema from '../db/schema';
import { publicProcedure, router } from '../trpc';

// Type assertion for router operations (development/test environment uses SQLite)
const routerDb = db as ReturnType<typeof import('drizzle-orm/bun-sqlite').drizzle>;

export const tokenPricesRouter = router({
  // Get all token prices
  getAll: publicProcedure.query(async () => {
    const prices = await routerDb
      .select()
      .from(schema.tokenPrices)
      .orderBy(desc(schema.tokenPrices.timestamp));
    return prices;
  }),

  // Get prices for a specific token
  getByTokenId: publicProcedure
    .input(z.object({ tokenId: z.string() }))
    .query(async ({ input }) => {
      const prices = await routerDb
        .select()
        .from(schema.tokenPrices)
        .where(eq(schema.tokenPrices.tokenId, input.tokenId))
        .orderBy(desc(schema.tokenPrices.timestamp));
      return prices;
    }),

  // Get latest price for a token
  getLatestByTokenId: publicProcedure
    .input(z.object({ tokenId: z.string(), baseTokenId: z.string().optional() }))
    .query(async ({ input }) => {
      const conditions = [eq(schema.tokenPrices.tokenId, input.tokenId)];

      if (input.baseTokenId) {
        conditions.push(eq(schema.tokenPrices.baseTokenId, input.baseTokenId));
      }

      const [latestPrice] = await routerDb
        .select()
        .from(schema.tokenPrices)
        .where(and(...conditions))
        .orderBy(desc(schema.tokenPrices.timestamp))
        .limit(1);

      return latestPrice || null;
    }),

  // Get prices by date range
  getByDateRange: publicProcedure
    .input(
      z.object({
        tokenId: z.string(),
        startDate: z.date(),
        endDate: z.date(),
        baseTokenId: z.string().optional(),
      })
    )
    .query(async ({ input }) => {
      const conditions = [
        eq(schema.tokenPrices.tokenId, input.tokenId),
        gte(schema.tokenPrices.timestamp, input.startDate),
        lte(schema.tokenPrices.timestamp, input.endDate),
      ];

      if (input.baseTokenId) {
        conditions.push(eq(schema.tokenPrices.baseTokenId, input.baseTokenId));
      }

      const prices = await routerDb
        .select()
        .from(schema.tokenPrices)
        .where(and(...conditions))
        .orderBy(desc(schema.tokenPrices.timestamp));

      return prices;
    }),

  // Get price at specific timestamp (or closest before)
  getPriceAtTime: publicProcedure
    .input(
      z.object({
        tokenId: z.string(),
        timestamp: z.date(),
        baseTokenId: z.string().optional(),
      })
    )
    .query(async ({ input }) => {
      const conditions = [
        eq(schema.tokenPrices.tokenId, input.tokenId),
        lte(schema.tokenPrices.timestamp, input.timestamp),
      ];

      if (input.baseTokenId) {
        conditions.push(eq(schema.tokenPrices.baseTokenId, input.baseTokenId));
      }

      const [priceAtTime] = await routerDb
        .select()
        .from(schema.tokenPrices)
        .where(and(...conditions))
        .orderBy(desc(schema.tokenPrices.timestamp))
        .limit(1);

      return priceAtTime || null;
    }),

  // Get price by ID
  getById: publicProcedure.input(z.object({ id: z.string() })).query(async ({ input }) => {
    const [tokenPrice] = await routerDb
      .select()
      .from(schema.tokenPrices)
      .where(eq(schema.tokenPrices.id, input.id))
      .limit(1);

    if (!tokenPrice) {
      throw new Error('Token price not found');
    }
    return tokenPrice;
  }),

  // Create new token price
  create: publicProcedure.input(CreateTokenPriceSchema).mutation(async ({ input }) => {
    const now = new Date();
    const tokenPriceData = {
      id: nanoid(),
      ...input,
      createdAt: now,
    };

    const [createdTokenPrice] = await routerDb
      .insert(schema.tokenPrices)
      .values(tokenPriceData)
      .returning();

    if (!createdTokenPrice) {
      throw new Error('Failed to create token price');
    }

    return createdTokenPrice;
  }),

  // Bulk create token prices
  createBulk: publicProcedure.input(z.array(CreateTokenPriceSchema)).mutation(async ({ input }) => {
    const now = new Date();
    const tokenPricesData = input.map((price) => ({
      id: nanoid(),
      ...price,
      createdAt: now,
    }));

    const createdTokenPrices = await routerDb
      .insert(schema.tokenPrices)
      .values(tokenPricesData)
      .returning();

    return createdTokenPrices;
  }),

  // Delete token price
  delete: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ input }) => {
    const [deletedTokenPrice] = await routerDb
      .delete(schema.tokenPrices)
      .where(eq(schema.tokenPrices.id, input.id))
      .returning();

    if (!deletedTokenPrice) {
      throw new Error('Token price not found');
    }

    return { success: true, deleted: deletedTokenPrice };
  }),

  // Delete old token prices (cleanup)
  deleteOlderThan: publicProcedure
    .input(
      z.object({
        cutoffDate: z.date(),
        tokenId: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const conditions = [lte(schema.tokenPrices.timestamp, input.cutoffDate)];

      if (input.tokenId) {
        conditions.push(eq(schema.tokenPrices.tokenId, input.tokenId));
      }

      const deletedPrices = await routerDb
        .delete(schema.tokenPrices)
        .where(and(...conditions))
        .returning();

      return {
        success: true,
        deletedCount: deletedPrices.length,
        deleted: deletedPrices,
      };
    }),
});
