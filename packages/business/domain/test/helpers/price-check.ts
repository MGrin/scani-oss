import type { DatabaseTransaction } from '@scani/db';
import { sql } from 'drizzle-orm';

/**
 * Lifts the CHECK on `token_prices.price` for the rest of `tx`, which the test
 * rolls back. The column refuses a price that is not a positive decimal, so
 * this is the only way to put the row a reader's defence exists for in front
 * of that reader. It holds the table's ACCESS EXCLUSIVE lock until the
 * rollback, so the wait for it is bounded.
 */
export async function liftPriceCheck(tx: DatabaseTransaction): Promise<void> {
  await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
  await tx.execute(
    sql`ALTER TABLE token_prices DROP CONSTRAINT token_prices_price_positive_decimal_chk`
  );
}
