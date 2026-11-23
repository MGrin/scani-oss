import type { DatabaseTransaction } from '@scani/db';
import { sql } from 'drizzle-orm';

export async function lockCategoryRuleOwner(
  tx: DatabaseTransaction,
  userId: string
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${'category-rules:' + userId}, 0))`
  );
}
