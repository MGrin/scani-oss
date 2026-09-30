import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { getDb } from '../../src';
import type { DatabaseTransaction } from '../../src/transaction';

/**
 * The one-account merge, run verbatim against the real schema inside a
 * transaction that is rolled back. This database has already applied it, so
 * the transaction first puts `cloud_api_keys` back the way the migration finds
 * it on production: no keys, and `owner_user_id` referencing `cloud_users`.
 * Statements are split on the breakpoint marker, as `migration-runner.ts` does.
 */
const MIGRATION = path.join(
  import.meta.dir,
  '..',
  '..',
  'src',
  'migrations',
  '20260929142850_sc_one_account_merge_cloud_users.sql'
);

const statements = readFileSync(MIGRATION, 'utf8')
  .split('--> statement-breakpoint')
  .map((chunk) => chunk.trim())
  .filter((chunk) => chunk.length > 0);

class Rollback extends Error {}
type Tx = DatabaseTransaction;

async function rows<T>(tx: Tx, query: ReturnType<typeof sql>): Promise<T[]> {
  return (await tx.execute(query)) as unknown as T[];
}

async function one<T>(tx: Tx, query: ReturnType<typeof sql>): Promise<T> {
  const [row] = await rows<T>(tx, query);
  if (!row) throw new Error('query returned no row');
  return row;
}

const id = (tx: Tx, query: ReturnType<typeof sql>) =>
  one<{ id: string }>(tx, query).then((r) => r.id);

async function restorePreMigrationState(tx: Tx) {
  await tx.execute(sql`SET LOCAL client_min_messages = warning`);
  await tx.execute(sql`DELETE FROM cloud_usage_events`);
  await tx.execute(sql`DELETE FROM cloud_api_keys`);
  await tx.execute(
    sql`ALTER TABLE cloud_api_keys DROP CONSTRAINT IF EXISTS cloud_api_keys_owner_user_id_users_id_fk`
  );
  await tx.execute(
    sql`ALTER TABLE cloud_api_keys DROP CONSTRAINT IF EXISTS cloud_api_keys_owner_user_id_cloud_users_id_fk`
  );
  await tx.execute(
    sql`ALTER TABLE cloud_api_keys ADD CONSTRAINT cloud_api_keys_owner_user_id_cloud_users_id_fk FOREIGN KEY (owner_user_id) REFERENCES cloud_users(id) ON DELETE CASCADE`
  );
}

const unique = (label: string) => `one-account-${label}-${crypto.randomUUID()}@example.test`;

const cloudUser = (
  tx: Tx,
  email: string,
  verified: boolean,
  createdAt: string,
  name: string | null = 'Cloud Name'
) =>
  id(
    tx,
    sql`INSERT INTO cloud_users (email, email_verified, name, created_at) VALUES (${email}, ${verified}, ${name}, ${createdAt}::timestamptz) RETURNING id`
  );

const appUser = (tx: Tx, email: string, createdAt: string, verified = true) =>
  id(
    tx,
    sql`INSERT INTO users (email, email_verified, name, created_at) VALUES (${email}, ${verified}, ${'App Name'}, ${createdAt}::timestamptz) RETURNING id`
  );

const createdOn = (tx: Tx, userId: string) =>
  one<{ at: string }>(
    tx,
    sql`SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS at FROM users WHERE id = ${userId}`
  );

const key = (tx: Tx, ownerId: string) =>
  id(
    tx,
    sql`INSERT INTO cloud_api_keys (owner_user_id, tenant_id, name, key_prefix, hashed_key) VALUES (${ownerId}, ${ownerId}, 'k', 'sk_', ${crypto.randomUUID()}) RETURNING id`
  );

const usage = (tx: Tx, subject: string) =>
  id(
    tx,
    sql`INSERT INTO cloud_usage_events (subject, route, provider, outcome, duration_ms) VALUES (${subject}, 'r', 'p', 'ok', 1) RETURNING id`
  );

const keyOwner = (tx: Tx, keyId: string) =>
  one<{ owner: string; tenant: string }>(
    tx,
    sql`SELECT owner_user_id::text AS owner, tenant_id::text AS tenant FROM cloud_api_keys WHERE id = ${keyId}`
  );

async function runMigration(tx: Tx) {
  for (const statement of statements) await tx.execute(sql.raw(statement));
}

test('keys and usage move to the matching app user, and cloud-only users become app users', async () => {
  const seen: Record<string, unknown> = {};
  try {
    await getDb().transaction(async (tx) => {
      await restorePreMigrationState(tx);

      const mergedEmail = unique('merged');
      const merged = await appUser(tx, mergedEmail, '2026-06-01T00:00:00Z');
      const mergedCloud = await cloudUser(
        tx,
        mergedEmail.replace('one-account', 'One-Account'),
        true,
        '2026-05-01T00:00:00Z'
      );
      const mergedKey = await key(tx, mergedCloud);
      const mergedUsage = await usage(tx, mergedCloud);

      const laterEmail = unique('later');
      const later = await appUser(tx, laterEmail, '2026-04-01T00:00:00Z');
      const laterCloud = await cloudUser(tx, laterEmail, true, '2026-07-01T00:00:00Z');
      const laterKey = await key(tx, laterCloud);

      const onlyEmail = unique('cloud-only');
      const onlyCloud = await cloudUser(tx, onlyEmail, true, '2026-03-01T00:00:00Z');
      const onlyKey = await key(tx, onlyCloud);

      const caseEmail = unique('case-twins');
      const twinA = await cloudUser(tx, caseEmail, true, '2026-02-02T00:00:00Z');
      const twinB = await cloudUser(tx, caseEmail.toUpperCase(), true, '2026-02-01T00:00:00Z');
      seen.caseEmail = caseEmail;
      const twinAKey = await key(tx, twinA);
      const twinBKey = await key(tx, twinB);

      const mergedTwinsEmail = unique('merged-twins');
      const mergedTwins = await appUser(tx, mergedTwinsEmail, '2026-06-01T00:00:00Z');
      await cloudUser(tx, mergedTwinsEmail, true, '2026-05-10T00:00:00Z');
      await cloudUser(tx, mergedTwinsEmail.toUpperCase(), true, '2026-05-01T00:00:00Z');

      const unverifiedAppEmail = unique('unverified-app');
      const unverifiedApp = await appUser(tx, unverifiedAppEmail, '2026-06-01T00:00:00Z', false);
      const unverifiedAppCloud = await cloudUser(
        tx,
        unverifiedAppEmail,
        true,
        '2026-06-02T00:00:00Z'
      );
      const unverifiedAppKey = await key(tx, unverifiedAppCloud);

      const namelessEmail = unique('nameless');
      await cloudUser(tx, namelessEmail, true, '2026-03-01T00:00:00Z', null);

      const unrelatedUsage = await usage(tx, 'tenant-without-a-cloud-user');

      await runMigration(tx);

      seen.mergedKey = await keyOwner(tx, mergedKey);
      seen.merged = merged;
      seen.mergedCount = await one<{ n: number }>(
        tx,
        sql`SELECT count(*)::int AS n FROM users WHERE lower(email) = lower(${mergedEmail})`
      );
      seen.mergedCreatedAt = await one<{ at: string }>(
        tx,
        sql`SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS at FROM users WHERE id = ${merged}`
      );
      seen.mergedUsage = await one<{ subject: string }>(
        tx,
        sql`SELECT subject FROM cloud_usage_events WHERE id = ${mergedUsage}`
      );

      seen.laterKey = await keyOwner(tx, laterKey);
      seen.later = later;
      seen.laterCreatedAt = await one<{ at: string }>(
        tx,
        sql`SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS at FROM users WHERE id = ${later}`
      );

      seen.onlyUser = await one<{
        id: string;
        name: string;
        verified: boolean;
        at: string;
        base: string | null;
        usd: string | null;
      }>(
        tx,
        sql`SELECT u.id::text AS id, u.name, u.email_verified AS verified,
                   to_char(u.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS at,
                   u.base_currency_id::text AS base,
                   (SELECT t.id::text FROM tokens t JOIN token_types tt ON tt.id = t.type_id
                     WHERE t.symbol = 'USD' AND tt.code = 'fiat' LIMIT 1) AS usd
            FROM users u WHERE lower(u.email) = lower(${onlyEmail})`
      );
      seen.onlyKey = await keyOwner(tx, onlyKey);
      seen.onlyCloud = onlyCloud;

      seen.twins = await rows<{ id: string; email: string }>(
        tx,
        sql`SELECT id::text AS id, email FROM users WHERE lower(email) = lower(${caseEmail})`
      );
      seen.mergedTwinsCreatedAt = await createdOn(tx, mergedTwins);
      seen.unverifiedApp = unverifiedApp;
      seen.unverifiedAppKey = await keyOwner(tx, unverifiedAppKey);
      seen.unverifiedAppVerified = await one<{ verified: boolean }>(
        tx,
        sql`SELECT email_verified AS verified FROM users WHERE id = ${unverifiedApp}`
      );
      seen.nameless = await rows<{ name: string }>(
        tx,
        sql`SELECT name FROM users WHERE lower(email) = lower(${namelessEmail})`
      );
      seen.twinAKey = await keyOwner(tx, twinAKey);
      seen.twinBKey = await keyOwner(tx, twinBKey);

      seen.unrelatedUsage = await one<{ subject: string }>(
        tx,
        sql`SELECT subject FROM cloud_usage_events WHERE id = ${unrelatedUsage}`
      );
      seen.fkTarget = await one<{ target: string }>(
        tx,
        sql`SELECT confrelid::regclass::text AS target FROM pg_constraint
            WHERE conrelid = 'cloud_api_keys'::regclass AND contype = 'f'
              AND conname = 'cloud_api_keys_owner_user_id_users_id_fk'`
      );
      seen.oldFk = await rows(
        tx,
        sql`SELECT 1 FROM pg_constraint WHERE conname = 'cloud_api_keys_owner_user_id_cloud_users_id_fk'`
      );
      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }

  expect(seen.mergedKey).toEqual({ owner: seen.merged, tenant: seen.merged });
  expect(seen.mergedCount).toEqual({ n: 1 });
  expect(seen.mergedCreatedAt).toEqual({ at: '2026-05-01' });
  expect(seen.mergedUsage).toEqual({ subject: seen.merged });

  expect(seen.laterKey).toEqual({ owner: seen.later, tenant: seen.later });
  expect(seen.laterCreatedAt).toEqual({ at: '2026-04-01' });

  const only = seen.onlyUser as {
    id: string;
    name: string;
    verified: boolean;
    at: string;
    base: string | null;
    usd: string | null;
  };
  expect(only.id).not.toBe(seen.onlyCloud);
  expect(only.name).toBe('Cloud Name');
  expect(only.verified).toBe(true);
  expect(only.at).toBe('2026-03-01');
  expect(only.usd).not.toBeNull();
  expect(only.base).toBe(only.usd);
  expect(seen.onlyKey).toEqual({ owner: only.id, tenant: only.id });

  const twins = seen.twins as { id: string; email: string }[];
  expect(twins).toHaveLength(1);
  expect(twins[0]?.email).toBe(seen.caseEmail as string);
  const twin = twins[0]?.id;
  expect(seen.twinAKey).toEqual({ owner: twin, tenant: twin });
  expect(seen.twinBKey).toEqual({ owner: twin, tenant: twin });

  expect(seen.mergedTwinsCreatedAt).toEqual({ at: '2026-05-01' });
  expect(seen.unverifiedAppKey).toEqual({
    owner: seen.unverifiedApp,
    tenant: seen.unverifiedApp,
  });
  expect(seen.unverifiedAppVerified).toEqual({ verified: true });
  expect(seen.nameless).toEqual([{ name: '' }]);

  expect(seen.unrelatedUsage).toEqual({ subject: 'tenant-without-a-cloud-user' });
  expect(seen.fkTarget).toEqual({ target: 'users' });
  expect(seen.oldFk).toEqual([]);
});

test('a key owned by an unverified cloud user aborts the migration', async () => {
  let failure: unknown = null;
  try {
    await getDb().transaction(async (tx) => {
      await restorePreMigrationState(tx);
      const unverified = await cloudUser(tx, unique('unverified'), false, '2026-03-01T00:00:00Z');
      await key(tx, unverified);
      try {
        await runMigration(tx);
      } catch (err) {
        failure = err;
      }
      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
  expect(String((failure as { cause?: unknown })?.cause ?? failure)).toContain(
    'cloud_api_keys owner has no users row'
  );
});
