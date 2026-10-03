import type { sql } from 'drizzle-orm';
import { getDb } from '../../src';
import type { DatabaseTransaction } from '../../src/transaction';

export type Tx = DatabaseTransaction;
export type Query = ReturnType<typeof sql>;

class Rollback extends Error {}

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
