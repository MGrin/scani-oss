import { sql } from 'drizzle-orm';
import { getDb } from '../../src';
import type { DatabaseTransaction } from '../../src/transaction';

export type Tx = DatabaseTransaction;
export type Query = ReturnType<typeof sql>;

class Rollback extends Error {}

/**
 * Runs a fixture's holdings insert as the engine calculator, the one writer
 * the holdings guard admits to the cached columns (A5 D-5); the domain
 * package's `seedHoldingCache`, for the tests below it. `tx` is a test's own
 * transaction, which the setting is local to.
 */
export async function seedHoldingCache<T>(tx: Tx, insert: () => Promise<T>): Promise<T> {
  await tx.execute(sql`SELECT set_config('scani.engine_writer', 'calculator', true)`);
  const result = await insert();
  await tx.execute(sql`SELECT set_config('scani.engine_writer', '', true)`);
  return result;
}

/** Runs `body` in a transaction that is always rolled back, so a test leaves nothing behind. */
export async function inRollback(body: (tx: Tx) => Promise<void>): Promise<void> {
  try {
    await getDb().transaction(async (tx) => {
      await body(tx);
      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
}

interface DriverError {
  code?: string;
  message?: string;
  cause?: { code?: string; message?: string };
}

/** Drizzle wraps the driver's error; the SQLSTATE and the server's message are on its `cause`. */
function sqlstate(err: unknown): string | undefined {
  const e = err as DriverError;
  return e.cause?.code ?? e.code;
}

function serverMessage(err: unknown): string | undefined {
  const e = err as DriverError;
  return e.cause?.message ?? e.message;
}

/**
 * Runs `statement` in a savepoint of its own and reports how the server
 * refused it, or `undefined` when it did not. A failed statement aborts the
 * whole transaction in Postgres, so without the savepoint the next statement
 * would fail for that reason and not the one under test.
 */
export async function refusal(
  tx: Tx,
  statement: Query
): Promise<{ code: string | undefined; message: string | undefined } | undefined> {
  try {
    await tx.transaction(async (savepoint) => {
      await savepoint.execute(statement);
    });
  } catch (err) {
    return { code: sqlstate(err), message: serverMessage(err) };
  }
  return undefined;
}

/** The SQLSTATE `statement` was refused with, or `undefined` when it went through. */
export async function refusedWith(tx: Tx, statement: Query): Promise<string | undefined> {
  return (await refusal(tx, statement))?.code;
}
