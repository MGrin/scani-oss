import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/connection';
import { institutionTypes } from '../db/schema';
import { publicProcedure, router } from '../trpc';

// Type assertion for router operations (development/test environment uses SQLite)
const routerDb = db as ReturnType<typeof import('drizzle-orm/bun-sqlite').drizzle>;

export const institutionTypesRouter = router({
  /**
   * Get all active institution types for UI dropdowns
   */
  getAll: publicProcedure.query(async () => {
    const types = await routerDb
      .select()
      .from(institutionTypes)
      .where(eq(institutionTypes.isActive, true))
      .orderBy(institutionTypes.displayOrder, institutionTypes.name);

    return types.map((type) => ({
      id: type.id,
      code: type.code,
      name: type.name,
      description: type.description,
      displayOrder: type.displayOrder,
    }));
  }),

  /**
   * Get institution type by ID
   */
  getById: publicProcedure
    .input(
      z.object({
        id: z.string(),
      })
    )
    .query(async ({ input }) => {
      const [institutionType] = await routerDb
        .select()
        .from(institutionTypes)
        .where(eq(institutionTypes.id, input.id))
        .limit(1);

      if (!institutionType) {
        throw new Error(`Institution type with ID ${input.id} not found`);
      }

      return {
        id: institutionType.id,
        code: institutionType.code,
        name: institutionType.name,
        description: institutionType.description,
        displayOrder: institutionType.displayOrder,
        isActive: institutionType.isActive,
        createdAt: institutionType.createdAt,
        updatedAt: institutionType.updatedAt,
      };
    }),

  /**
   * Get institution type by code
   */
  getByCode: publicProcedure
    .input(
      z.object({
        code: z.string(),
      })
    )
    .query(async ({ input }) => {
      const [institutionType] = await routerDb
        .select()
        .from(institutionTypes)
        .where(eq(institutionTypes.code, input.code))
        .limit(1);

      if (!institutionType) {
        throw new Error(`Institution type with code ${input.code} not found`);
      }

      return {
        id: institutionType.id,
        code: institutionType.code,
        name: institutionType.name,
        description: institutionType.description,
        displayOrder: institutionType.displayOrder,
        isActive: institutionType.isActive,
      };
    }),
});
