/**
 * The list in `holding-untouched.ts` has to stay exhaustive, and nothing about
 * adding a table with an FK to `holdings` prompts anybody to come and read
 * that file (SC-631).
 *
 * So this asks Postgres instead. Every foreign key pointing at `holdings` is
 * a way for `clearAnswer` to cascade a fact away when it deletes a holding an
 * answer created; the predicate must either COUNT that table as intent or have
 * been decided to be derived. A new table is therefore a failure here, at the
 * moment it is added, rather than a silent widening of what a reopen destroys.
 */

import { describe, expect, test } from 'bun:test';
import { db } from '@scani/db/connection';
import { sql } from 'drizzle-orm';
import { HOLDING_DERIVED_TABLES, HOLDING_INTENT_TABLES } from '../../src/lib/holding-untouched';

describe('holdingIsUntouched — the child tables it has to know about', () => {
  test('every FK pointing at holdings is either intent or explicitly derived', async () => {
    const rows = await db.execute<{ child_table: string }>(sql`
      select distinct child.relname as child_table
        from pg_constraint c
        join pg_class child on child.oid = c.conrelid
        join pg_class parent on parent.oid = c.confrelid
        join pg_namespace ns on ns.oid = child.relnamespace
       where c.contype = 'f'
         and parent.relname = 'holdings'
         and ns.nspname = 'public'
    `);

    const children = [...rows].map((r) => r.child_table).sort();
    const accounted = [...HOLDING_INTENT_TABLES, ...HOLDING_DERIVED_TABLES].sort();

    // Named rather than counted: a failure here should say WHICH table nobody
    // has decided about, because the decision is the whole point.
    expect(children).toEqual(accounted);
  });

  test('the derived list is not empty, and coverage is on it', () => {
    // The control for the test above. If `HOLDING_DERIVED_TABLES` were ever
    // emptied to make that one pass, the predicate would count
    // `holding_coverage` — which `writeInflow` creates for every holding it
    // opens — and would then answer "touched" for every row, forever. Green,
    // and deleting nothing.
    expect([...HOLDING_DERIVED_TABLES]).toContain('holding_coverage');
  });
});
