import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import postgres from 'postgres';

/**
 * SC-934 — one account per mailbox, case-insensitively.
 *
 * `users.email` is the identity billing will resolve entitlement against, and
 * it carried no unique constraint at all while `cloud_users.email` had one. The
 * failure was never "a duplicate row": it was a paying customer's entitlement
 * landing on a different account registered with the same address.
 *
 * The positive arm — the index exists — is the weak half. A unique index can
 * exist and still admit the collision that matters, which is exactly what a
 * plain `UNIQUE(email)` does: `A@b.com` beside `a@b.com` is one mailbox and two
 * legal rows. So the load-bearing test is the CASE arm, and it is written
 * against a real database because the claim is about what Postgres refuses, not
 * about what the Drizzle declaration says.
 *
 * The third arm is the control, and without it the second proves nothing: an
 * insert that is refused for an unrelated reason — a missing NOT NULL column, a
 * foreign key — reads identically to one refused by this index. So a row with a
 * distinct address must be ACCEPTED on the same connection, in the same
 * transaction, through the same statement.
 *
 * Everything runs inside a transaction that is always rolled back. Repository
 * suites in this repo assert GLOBAL row counts, so a `users` row left behind
 * fails tests in files this one never touched.
 */
const DATABASE_URL = process.env.DATABASE_URL;

let sql: postgres.Sql;

beforeAll(() => {
  if (!DATABASE_URL) throw new Error('DATABASE_URL is required for users-email-uniqueness tests');
  sql = postgres(DATABASE_URL, { max: 2, onnotice: () => {} });
});

afterAll(async () => {
  await sql.end();
});

/**
 * Runs `fn` on a reserved connection inside a transaction that is ALWAYS rolled
 * back, on every path including a throw. A dedicated connection rather than
 * `sql.begin` so the body can observe a statement failing without the helper
 * having to smuggle its return value out past a thrown rollback sentinel.
 */
async function inRolledBackTx<T>(fn: (tx: postgres.ReservedSql) => Promise<T>): Promise<T> {
  const conn = await sql.reserve();
  try {
    await conn`begin`;
    return await fn(conn);
  } finally {
    await conn`rollback`;
    conn.release();
  }
}

/**
 * A distinct address per invocation. A fixed literal would collide with a
 * concurrently running copy of this file against a shared database, and the
 * failure would look exactly like the defect under test.
 */
function address(local: string): string {
  return `${local}.${crypto.randomUUID()}@sc934.test`;
}

type InsertOutcome = { ok: true } | { ok: false; code: string | undefined };

async function insertUser(tx: postgres.ReservedSql, email: string): Promise<InsertOutcome> {
  try {
    await tx`insert into users (email, name) values (${email}, ${'SC-934 fixture'})`;
    return { ok: true };
  } catch (err) {
    return { ok: false, code: (err as { code?: string }).code };
  }
}

describe('users.email uniqueness (SC-934)', () => {
  test('a unique index covers lower(email)', async () => {
    const rows = await sql<{ indexdef: string }[]>`
      select indexdef from pg_indexes
      where schemaname = current_schema() and tablename = 'users'
    `;
    const covering = rows.filter(
      (r) => /unique/i.test(r.indexdef) && /lower\(\(?email\)?/i.test(r.indexdef)
    );
    expect(covering.length).toBeGreaterThan(0);
  });

  test('a second account on the same address is refused', async () => {
    const outcome = await inRolledBackTx(async (tx) => {
      const email = address('same');
      expect(await insertUser(tx, email)).toEqual({ ok: true });
      return await insertUser(tx, email);
    });
    expect(outcome).toEqual({ ok: false, code: '23505' });
  });

  test('a second account differing only in CASE is refused', async () => {
    const outcome = await inRolledBackTx(async (tx) => {
      const email = address('cased');
      expect(await insertUser(tx, email)).toEqual({ ok: true });
      return await insertUser(tx, email.toUpperCase());
    });
    expect(outcome).toEqual({ ok: false, code: '23505' });
  });

  test('CONTROL — a distinct address is accepted by the same statement', async () => {
    const outcome = await inRolledBackTx(async (tx) => {
      expect(await insertUser(tx, address('first'))).toEqual({ ok: true });
      return await insertUser(tx, address('second'));
    });
    expect(outcome).toEqual({ ok: true });
  });
});
