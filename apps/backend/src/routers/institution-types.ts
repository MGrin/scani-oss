import { eq } from 'drizzle-orm';

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
});
