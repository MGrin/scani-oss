/**
 * Is anything at all recorded against this holding? (SC-631)
 *
 * The question a reopen has to answer before deleting the holding its answer
 * created. Every table below is `ON DELETE CASCADE` on `holdings.id`, so the
 * database will not refuse — the refusal has to be here, and it has to be
 * exhaustive, because what cascades away is a fact somebody put there.
 *
 * ## Why the ledger is not the whole test
 *
 * A `growth` balance edit writes an OBSERVATION and no ledger row at all
 * (`ManualBalanceEditService` returns before the transaction insert). So a
 * holding with zero `holding_transactions` can still be carrying a figure the
 * owner typed, and a predicate that asked only about the ledger would delete
 * it. The same is true of an APY rate, a group membership and a vault
 * allocation: none of them is a transaction and all of them are somebody's
 * intent.
 *
 * ## The one exclusion, and why it is not an oversight
 *
 * `holding_coverage` is DERIVED — `syncTxBoundsFromLedger` recomputes it from
 * the ledger, and `writeInflow` calls that on the row it just created, so
 * every created destination has one before anybody could have touched it.
 * Counting it would make this predicate answer `false` always, which is a
 * fix-shaped thing: the code would look like it deletes and never would.
 *
 * ## Why the list is stated rather than derived
 *
 * A new table with an FK to `holdings` is a new way to lose a fact here, and
 * nothing about adding one prompts anybody to come and read this file.
 * `tests/lib/holding-untouched.test.ts` asks Postgres for every foreign key
 * referencing `holdings` and fails if the answer is not exactly this list plus
 * the derived one — so the decision is forced at the moment the table is
 * added, and defaults to safe rather than to silence.
 */

import type { DatabaseTransaction } from '@scani/db';
import * as schema from '@scani/db/schema';
import { and, eq, sql } from 'drizzle-orm';

/** Every table whose rows are somebody's intent about a holding. Deleting the
 *  holding cascades them away, so a row in any one of them is a refusal. */
export const HOLDING_INTENT_TABLES = [
  'holding_transactions',
  'holding_balance_observations',
  'holding_apy_configs',
  'holding_groups',
  'holding_group_exclusions',
  'vault_holdings',
] as const;

/** Derived from the ledger and rebuilt on demand, so it records nothing that
 *  a delete could lose. See the docblock — this is the exclusion the FK test
 *  checks against, not an omission. */
export const HOLDING_DERIVED_TABLES = ['holding_coverage'] as const;

/**
 * True when nothing in `HOLDING_INTENT_TABLES` references this holding.
 *
 * Scoped to `userId` on the holding itself rather than on each child, because
 * the children inherit the holding's owner through the FK and a caller that
 * has the wrong user must get `false` for the holding, not a per-table answer.
 */
export async function holdingIsUntouched(
  tx: DatabaseTransaction,
  userId: string,
  holdingId: string
): Promise<boolean> {
  const [owned] = await tx
    .select({ id: schema.holdings.id })
    .from(schema.holdings)
    .where(and(eq(schema.holdings.id, holdingId), eq(schema.holdings.userId, userId)))
    .limit(1);
  if (!owned) return false;

  const [row] = await tx.execute<{ touched: boolean }>(sql`
    select exists (
      select 1 from holding_transactions where holding_id = ${holdingId}
      union all
      select 1 from holding_balance_observations where holding_id = ${holdingId}
      union all
      select 1 from holding_apy_configs where holding_id = ${holdingId}
      union all
      select 1 from holding_groups where holding_id = ${holdingId}
      union all
      select 1 from holding_group_exclusions where holding_id = ${holdingId}
      union all
      select 1 from vault_holdings where holding_id = ${holdingId}
    ) as touched
  `);
  return row?.touched === false;
}
