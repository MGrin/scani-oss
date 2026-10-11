import { randomUUID } from 'node:crypto';
import type { DatabaseTransaction } from '@scani/db';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { SnapshotWriter } from '@scani/domain/services/feeds/SnapshotWriter';
import {
  makeAccount,
  makeHolding,
  makeInstitution,
  makeInstitutionType,
  makeToken,
} from '@scani/domain/test-helpers';
import { InMemoryInflowRateLimiter } from '@scani/rate-limiter';
import { inArray, type SQL, sql } from 'drizzle-orm';
import { Container } from 'typedi';
import { PersonalAccessTokenService } from '../../src/auth/personal-access-tokens';
import { setSessionRevokeLimiterForContext } from '../../src/presentation/trpc';

/**
 * The seeded tenant every agent-write test starts from (SC-1617), shared so
 * the MCP and REST transports are tested against the same data and the same
 * write cases (SC-1648).
 */

export const suffix = randomUUID().slice(0, 8);
export const seedDb = db as unknown as DatabaseTransaction;

/** Rows that move on their own and are not portfolio data. */
const NOT_COMPARED: Record<string, string> = {
  personal_access_tokens: '`last_used_at` moves on every call',
  agent_writes: 'the activity log itself',
  agent_calls: 'the call log, which every call appends to (SC-1618)',
  agent_write_locks: 'held only while a write runs',
  portfolio_value_daily: 'derived; the rollup recomputes it after an undo',
  user_jobs: 'job bookkeeping for the rollup enqueue',
};

const THROUGH_A_PARENT: [string, (userId: string) => SQL][] = [
  ['institutions', (u) => sql`created_by_user_id = ${u}`],
  ['holding_coverage', (u) => sql`holding_id IN (SELECT id FROM holdings WHERE user_id = ${u})`],
  ['vault_holdings', (u) => sql`vault_id IN (SELECT id FROM vaults WHERE user_id = ${u})`],
];

export async function userData(userId: string): Promise<Record<string, string[]>> {
  const tables = await db.execute<{ table_name: string }>(sql`
    SELECT DISTINCT c.table_name FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = current_schema() AND c.column_name = 'user_id'
      AND t.table_type = 'BASE TABLE'
    ORDER BY c.table_name
  `);
  const out: Record<string, string[]> = {};
  for (const { table_name } of tables) {
    if (NOT_COMPARED[table_name]) continue;
    const rows = await db.execute<{ image: string }>(sql`
      SELECT to_jsonb(t)::text AS image FROM ${sql.raw(`"${table_name}"`)} t
      WHERE user_id = ${userId}
    `);
    out[table_name] = rows.map((r) => r.image).sort();
  }
  for (const [table, scope] of THROUGH_A_PARENT) {
    const rows = await db.execute<{ image: string }>(sql`
      SELECT to_jsonb(t)::text AS image FROM ${sql.raw(`"${table}"`)} t WHERE ${scope(userId)}
    `);
    out[table] = rows.map((r) => r.image).sort();
  }
  return out;
}

/** A balance the person typed, written as creating the holding writes it. */
export async function reading(userId: string, holdingId: string, amount: string, at: Date) {
  await Container.get(SnapshotWriter).record(
    {
      userId,
      holdingId,
      amount,
      at,
      cause: 'flow',
      legacySource: 'sync-capture',
      legacyMeta: { origin: 'createHoldingWithEvent', source: 'manual' },
    },
    { cache: 'unchanged' },
    seedDb
  );
}

export interface Tenant {
  userId: string;
  writeToken: string;
  readToken: string;
  accountId: string;
  otherAccountId: string;
  holdingId: string;
  outflowId: string;
  /** A synced holding whose balance fell 1000 -> 800 with no transaction. */
  gapHoldingId: string;
  gapDestinationHoldingId: string;
  gapObservationId: string;
}

const users: string[] = [];
export const tokenIds: string[] = [];
const institutionIds: string[] = [];
export let baseCurrencyId: string;

export async function seedTenant(name: string): Promise<Tenant> {
  const [user] = await db
    .insert(schema.users)
    .values({ email: `sc1617-${name}-${suffix}@scani.local`, name, baseCurrencyId })
    .returning();
  if (!user) throw new Error(`user insert failed: ${name}`);
  users.push(user.id);

  const type = await makeInstitutionType(seedDb, { code: 'bank' });
  const institution = await makeInstitution(seedDb, {
    typeId: type.id,
    name: `${name}-bank-${suffix}`,
  });
  institutionIds.push(institution.id);
  const account = await makeAccount(seedDb, {
    userId: user.id,
    institutionId: institution.id,
    name: `${name}-main-${suffix}`,
  });
  const other = await makeAccount(seedDb, {
    userId: user.id,
    institutionId: institution.id,
    name: `${name}-savings-${suffix}`,
  });
  const token = await makeToken(seedDb, { symbol: `W${name.toUpperCase()}${suffix}`.slice(0, 18) });
  tokenIds.push(token.id);
  const holding = await makeHolding(seedDb, {
    userId: user.id,
    accountId: account.id,
    tokenId: token.id,
    balance: '42',
  });
  const [outflow] = await db
    .insert(schema.holdingTransactions)
    .values({
      userId: user.id,
      holdingId: holding.id,
      tokenId: token.id,
      kind: 'withdraw',
      quantity: '3',
      occurredAt: new Date('2026-09-01T00:00:00Z'),
      source: 'test-fixture',
      externalId: randomUUID(),
    })
    .returning();
  if (!outflow) throw new Error('outflow insert failed');
  // The reading the cache is the engine's answer to (A5 D-17).
  await reading(user.id, holding.id, '42', new Date('2026-09-02T00:00:00Z'));

  // A balance gap: two sync readings of one wallet holding, nothing between.
  const gapToken = await makeToken(seedDb, {
    symbol: `G${name.toUpperCase()}${suffix}`.slice(0, 18),
  });
  tokenIds.push(gapToken.id);
  const gapHolding = await makeHolding(seedDb, {
    userId: user.id,
    accountId: account.id,
    tokenId: gapToken.id,
    balance: '800',
    source: 'wallet',
  });
  const gapDestination = await makeHolding(seedDb, {
    userId: user.id,
    accountId: other.id,
    tokenId: gapToken.id,
    balance: '700',
    source: 'manual',
  });
  await reading(user.id, gapDestination.id, '700', new Date('2025-12-31T00:00:00Z'));
  const [, closing] = await db
    .insert(schema.holdingBalanceObservations)
    .values([
      {
        userId: user.id,
        holdingId: gapHolding.id,
        balance: '1000',
        observedAt: new Date('2026-01-01T00:00:00Z'),
        source: 'sync-capture',
      },
      {
        userId: user.id,
        holdingId: gapHolding.id,
        balance: '800',
        observedAt: new Date('2026-01-03T00:00:00Z'),
        source: 'sync-capture',
      },
    ])
    .returning();
  if (!closing) throw new Error('observation insert failed');

  const tokens = new PersonalAccessTokenService();
  const write = await tokens.create(user.id, `${name} writer`, { allowWrites: true });
  const read = await tokens.create(user.id, `${name} reader`);
  return {
    userId: user.id,
    writeToken: write.token,
    readToken: read.token,
    accountId: account.id,
    otherAccountId: other.id,
    holdingId: holding.id,
    outflowId: outflow.id,
    gapHoldingId: gapHolding.id,
    gapDestinationHoldingId: gapDestination.id,
    gapObservationId: closing.id,
  };
}

/** Seeds the base currency every tenant values in. Call once, in `beforeAll`. */
export async function seedBaseCurrency(): Promise<void> {
  setSessionRevokeLimiterForContext(
    new InMemoryInflowRateLimiter({ windowMs: 60_000, max: 1000, namespace: `rl:w-${suffix}` })
  );
  const base = await makeToken(seedDb, {
    symbol: `WB${suffix}`.slice(0, 18),
    name: 'SC-1617 base',
  });
  tokenIds.push(base.id);
  baseCurrencyId = base.id;
}

export async function removeTenants(): Promise<void> {
  await db.delete(schema.users).where(inArray(schema.users.id, users));
  await db.delete(schema.institutions).where(inArray(schema.institutions.id, institutionIds));
  await db.delete(schema.tokens).where(inArray(schema.tokens.id, tokenIds.reverse()));
}

/** Every agent write, as a tool name and its arguments for one tenant. */
export const WRITE_CASES: [string, (t: Tenant) => [string, Record<string, unknown>]][] = [
  [
    'record_movement inflow',
    (t) => [
      'record_movement',
      {
        direction: 'inflow',
        holdingId: t.holdingId,
        amount: '5',
        occurredAt: '2026-10-01T09:00:00Z',
      },
    ],
  ],
  [
    'record_movement transfer, creating the destination holding, with a fee',
    (t) => [
      'record_movement',
      {
        direction: 'transfer',
        holdingId: t.holdingId,
        amount: '10',
        feeQuantity: '1',
        occurredAt: '2026-10-02T09:00:00Z',
        destinationAccountId: t.otherAccountId,
      },
    ],
  ],
  [
    'create_holdings',
    (t) => [
      'create_holdings',
      { accountId: t.accountId, holdings: [{ tokenId: baseCurrencyId, balance: '250' }] },
    ],
  ],
  [
    'answer_transfer_review',
    (t) => ['answer_transfer_review', { transactionId: t.outflowId, decision: 'left_control' }],
  ],
  [
    'answer_balance_gap: a flow moved to another holding, with a fee',
    (t) => [
      'answer_balance_gap',
      {
        observationId: t.gapObservationId,
        answer: 'flow',
        editOutflow: {
          decision: 'internal',
          destination: { accountId: t.otherAccountId, holdingId: t.gapDestinationHoldingId },
          feeQuantity: '5',
        },
      },
    ],
  ],
  [
    'answer_balance_gap: growth',
    (t) => ['answer_balance_gap', { observationId: t.gapObservationId, answer: 'growth' }],
  ],
];
