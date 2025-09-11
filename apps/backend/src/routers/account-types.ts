import { eq } from 'drizzle-orm';
import { db } from '../db/connection';
import * as schema from '../db/schema';
import { protectedProcedure, router } from '../trpc';

export const accountTypesRouter = router({
  // Get all account types
  getAll: protectedProcedure.query(async () => {
    const accountTypes = await db
      .select()
      .from(schema.accountTypes)
      .where(eq(schema.accountTypes.isActive, true))
      .orderBy(schema.accountTypes.displayOrder, schema.accountTypes.name);
    return accountTypes;
  }),
});
