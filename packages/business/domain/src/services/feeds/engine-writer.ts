import type { DatabaseTransaction } from '@scani/db';
import { sql } from 'drizzle-orm';

/**
 * Runs `write` as the engine calculator, the one writer the holdings guard
 * admits to `balance`, `value_base` and `value_priced_at` (A5 D-2). The setting
 * is cleared afterwards, so a later statement in the same transaction is
 * guarded again.
 *
 * In a savepoint of its own: the setting is transaction-local, so it reaches
 * the write only inside one transaction with it, and a write that fails rolls
 * the setting back with it.
 */
export function asEngineCalculator<T>(
  tx: DatabaseTransaction,
  write: (tx: DatabaseTransaction) => Promise<T>
): Promise<T> {
  return tx.transaction(async (inner) => {
    await inner.execute(sql`SELECT set_config('scani.engine_writer', 'calculator', true)`);
    const result = await write(inner);
    await inner.execute(sql`SELECT set_config('scani.engine_writer', '', true)`);
    return result;
  });
}
