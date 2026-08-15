#!/usr/bin/env bun

/**
 * The portfolio `measure-cold-boot.ts` measures against.
 *
 * The shape matters more than the size. Twenty holdings over 400 days is what
 * SC-130 used, and it is enough that `dashboard.getOverview` does a real
 * valuation pass and `portfolio.getNetWorthSeries` reads real per-holding
 * rollup rows rather than answering instantly off an empty table — a waterfall
 * measured against a portfolio with nothing in it makes every server hop free
 * and every parallelisation look better than it is.
 *
 *   DATABASE_URL=postgres://postgres@127.0.0.1:5497/scani_test \
 *     bun scripts/seed-cold-boot.ts
 *
 * Idempotent: it deletes the harness user first, so re-running rebuilds rather
 * than accumulating.
 */

import { getDb } from '@scani/db';
import * as schema from '@scani/db/schema';
import { eq, sql } from 'drizzle-orm';

export const HARNESS_EMAIL = 'cold-boot@scani.local';

const HOLDINGS = 20;
const DAYS = 400;

const db = getDb();

const [existing] = await db
  .select()
  .from(schema.users)
  .where(eq(schema.users.email, HARNESS_EMAIL));
if (existing) await db.delete(schema.users).where(eq(schema.users.id, existing.id));

const [tokenType] = await db
  .insert(schema.tokenTypes)
  .values({ code: 'crypto', name: 'Crypto' })
  .onConflictDoUpdate({ target: schema.tokenTypes.code, set: { code: 'crypto' } })
  .returning();
const [fiatType] = await db
  .insert(schema.tokenTypes)
  .values({ code: 'fiat', name: 'Fiat' })
  .onConflictDoUpdate({ target: schema.tokenTypes.code, set: { code: 'fiat' } })
  .returning();
const [institutionType] = await db
  .insert(schema.institutionTypes)
  .values({ code: 'bank', name: 'Bank' })
  .onConflictDoUpdate({ target: schema.institutionTypes.code, set: { code: 'bank' } })
  .returning();
const [accountType] = await db
  .insert(schema.accountTypes)
  .values({ code: 'wallet', name: 'Wallet' })
  .onConflictDoUpdate({ target: schema.accountTypes.code, set: { code: 'wallet' } })
  .returning();

// The seed migrations already ship USD; take theirs when it is there so the
// harness user's base currency is the one the rest of the schema references.
const [seededUsd] = await db.select().from(schema.tokens).where(eq(schema.tokens.symbol, 'USD'));
const usd =
  seededUsd ??
  (
    await db
      .insert(schema.tokens)
      .values({ symbol: 'USD', name: 'US Dollar', typeId: fiatType!.id })
      .returning()
  )[0];

const [user] = await db
  .insert(schema.users)
  .values({ email: HARNESS_EMAIL, name: 'Cold Boot', baseCurrencyId: usd!.id })
  .returning();

const [institution] = await db
  .insert(schema.institutions)
  .values({ name: 'Harness Bank', typeId: institutionType!.id })
  .returning();
const [account] = await db
  .insert(schema.accounts)
  .values({
    userId: user!.id,
    institutionId: institution!.id,
    typeId: accountType!.id,
    name: 'Harness Account',
  })
  .returning();

const holdingIds: string[] = [];
for (let i = 0; i < HOLDINGS; i++) {
  const [token] = await db
    .insert(schema.tokens)
    .values({ symbol: `CB${i}`, name: `Cold Boot ${i}`, typeId: tokenType!.id })
    .returning();
  const [holding] = await db
    .insert(schema.holdings)
    .values({
      userId: user!.id,
      accountId: account!.id,
      tokenId: token!.id,
      balance: String(10 + i),
      source: 'manual',
    })
    .returning();
  holdingIds.push(holding!.id);
  await db.insert(schema.tokenPrices).values({
    tokenId: token!.id,
    baseTokenId: usd!.id,
    price: String(100 + i * 7),
    timestamp: new Date(),
    source: 'harness',
  });
}

const today = new Date();
const rows: (typeof schema.portfolioValueDaily.$inferInsert)[] = [];
for (let day = DAYS - 1; day >= 0; day--) {
  const date = new Date(today.getTime() - day * 86_400_000).toISOString().slice(0, 10);
  for (let i = 0; i < holdingIds.length; i++) {
    const value = (10 + i) * (100 + i * 7) * (1 + Math.sin(day / 30) * 0.05);
    rows.push({
      userId: user!.id,
      scopeKind: 'holding',
      scopeId: holdingIds[i]!,
      snapshotDate: date,
      baseCurrencyId: usd!.id,
      totalValue: value.toFixed(2),
      coverageQuality: 'complete',
      holdingsWithKnownValue: 1,
      holdingsTotal: 1,
      costBasis: (value * 0.8).toFixed(2),
      realizedPnl: '0',
      unrealizedPnl: (value * 0.2).toFixed(2),
    });
  }
}
for (let i = 0; i < rows.length; i += 2000) {
  await db.insert(schema.portfolioValueDaily).values(rows.slice(i, i + 2000));
}

const counted = await db
  .select({ count: sql<number>`count(*)::int` })
  .from(schema.portfolioValueDaily)
  .where(eq(schema.portfolioValueDaily.userId, user!.id));

console.log(`seeded ${HARNESS_EMAIL}: ${HOLDINGS} holdings, ${counted[0]?.count} rollup rows`);
process.exit(0);
