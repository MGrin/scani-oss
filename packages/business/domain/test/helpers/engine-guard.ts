import type { DatabaseTransaction } from '@scani/db';
import { sql } from 'drizzle-orm';
import { asEngineCalculator } from '../../src/services/feeds/engine-writer';

/**
 * Seeds holdings as a fixture states them, funded or not: the one way a test
 * writes the columns only the calculator writes (A5 D-5). The setting covers
 * this insert only, so the production writer under test gets no exemption.
 */
export function seedHoldingCache<T>(
  tx: DatabaseTransaction,
  insert: (calculator: DatabaseTransaction) => Promise<T>
): Promise<T> {
  return asEngineCalculator(tx, insert);
}

/**
 * Turns the engine writer guard off for this test's transaction only; the
 * rollback turns it on again. A control: it shows a refusal is the guard's.
 */
export async function guardOff(tx: DatabaseTransaction): Promise<void> {
  await tx.execute(sql`ALTER TABLE holdings DISABLE TRIGGER holdings_engine_writer_guard`);
}

/**
 * The SQLSTATE `run` failed with, inside a savepoint so the test's transaction
 * survives it, or undefined when it ran.
 */
export async function sqlStateOf(
  tx: DatabaseTransaction,
  run: (savepoint: DatabaseTransaction) => Promise<unknown>
): Promise<string | undefined> {
  try {
    await tx.transaction(async (savepoint) => {
      await run(savepoint as DatabaseTransaction);
    });
    return undefined;
  } catch (error) {
    const failed = error as { code?: string; cause?: { code?: string } };
    return failed.cause?.code ?? failed.code;
  }
}
