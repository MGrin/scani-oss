import { eq } from 'drizzle-orm';
import { db } from '../db/connection';
import * as schema from '../db/schema';
import { protectedProcedure, router } from '../trpc';

export const tokenTypesRouter = router({
  // Get all token types
  getAll: protectedProcedure.query(async () => {
    const tokenTypes = await db
      .select()
      .from(schema.tokenTypes)
      .where(eq(schema.tokenTypes.isActive, true))
      .orderBy(schema.tokenTypes.displayOrder, schema.tokenTypes.name);
    return tokenTypes;
  }),
});
