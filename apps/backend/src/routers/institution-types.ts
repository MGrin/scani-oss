import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/connection';
import * as schema from '../db/schema';
import { publicProcedure, router } from '../trpc';

export const institutionTypesRouter = router({
  /**
   * Get all active institution types for UI dropdowns
   */
  getAll: publicProcedure.query(async () => {
    const types = await db
      .select()
      .from(schema.institutionTypes)
      .where(eq(schema.institutionTypes.isActive, true))
      .orderBy(schema.institutionTypes.displayOrder, schema.institutionTypes.name);

    return types.map((type: typeof schema.institutionTypes.$inferSelect) => ({
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
      const [institutionType] = await db
        .select()
        .from(schema.institutionTypes)
        .where(eq(schema.institutionTypes.id, input.id))
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
      const [institutionType] = await db
        .select()
        .from(schema.institutionTypes)
        .where(eq(schema.institutionTypes.code, input.code))
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
