import { eq } from 'drizzle-orm';
import { db } from '../db/connection';
import * as schema from '../db/schema';
import { protectedProcedure, router } from '../trpc';

export const transactionTypesRouter = router({
  // Get all transaction types
  getAll: protectedProcedure.query(async () => {
    const transactionTypes = await db
      .select()
      .from(schema.transactionTypes)
      .where(eq(schema.transactionTypes.isActive, true))
      .orderBy(schema.transactionTypes.displayOrder, schema.transactionTypes.name);
    return transactionTypes;
  }),
});
