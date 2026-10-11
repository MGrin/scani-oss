import type { DatabaseTransaction } from '@scani/db';
import { getDb } from '@scani/db/connection';
import type { NewReturnsLastComplete, ReturnsLastComplete } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { and, eq, lt, ne, or } from 'drizzle-orm';
import { Service } from 'typedi';

// Home asks for three windows on every load; a stored answer younger than this
// is kept rather than rewritten each time.
const REPLACE_AFTER_MS = 5 * 60 * 1000;

/** SC-1694: the last eligible returns answer per user, scope and window. */
@Service()
export class ReturnsLastCompleteRepository {
  async find(
    userId: string,
    scopeKey: string,
    windowKey: string,
    tx?: DatabaseTransaction
  ): Promise<ReturnsLastComplete | null> {
    const table = schema.returnsLastComplete;
    const [row] = await (tx ?? getDb())
      .select()
      .from(table)
      .where(
        and(eq(table.userId, userId), eq(table.scopeKey, scopeKey), eq(table.windowKey, windowKey))
      )
      .limit(1);
    return row ?? null;
  }

  /** Replaces the stored answer once it is REPLACE_AFTER_MS old, or at once if the currency moved. */
  async save(row: NewReturnsLastComplete, tx?: DatabaseTransaction): Promise<void> {
    const table = schema.returnsLastComplete;
    const staleBefore = new Date(row.computedAt.getTime() - REPLACE_AFTER_MS);
    await (tx ?? getDb())
      .insert(table)
      .values(row)
      .onConflictDoUpdate({
        target: [table.userId, table.scopeKey, table.windowKey],
        set: {
          baseCurrencyId: row.baseCurrencyId,
          answer: row.answer,
          computedAt: row.computedAt,
        },
        setWhere: or(
          lt(table.computedAt, staleBefore),
          ne(table.baseCurrencyId, row.baseCurrencyId)
        ),
      });
  }
}
