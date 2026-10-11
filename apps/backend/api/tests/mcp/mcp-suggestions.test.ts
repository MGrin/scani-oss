/**
 * SC-1616's falsifier: every number the suggestion tools state matches the
 * app's own figure for the same holding and day. The app's figures are
 * `holdings.getWithDetails` read through the `@scani/shared` holding figures —
 * the functions the Holdings screen renders with — so each tool output is
 * compared against those, not against a re-derivation in the test.
 *
 * Fixture, in a base currency of the user's own:
 *   CRYPTO 10 units, bought at 50, now 100   → value 1000, one lot cost 500
 *   STOCK   5 units, bought at 30, now 20    → value  100, one lot cost 150
 *   cash  300 of the base currency           → value  300
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { DatabaseTransaction } from '@scani/db';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import {
  makeAccount,
  makeHolding,
  makeInstitution,
  makeInstitutionType,
  makeToken,
} from '@scani/domain/test-helpers';
import { InMemoryInflowRateLimiter } from '@scani/rate-limiter';
import {
  type HoldingWithDetails,
  holdingGainLoss,
  holdingsValue,
  holdingTypeTotals,
} from '@scani/shared';
import { eq, inArray } from 'drizzle-orm';
import { MCP_TOOLS } from '../../src/mcp/tools';
import { appRouter } from '../../src/presentation/router';
import { createAgentContext, setSessionRevokeLimiterForContext } from '../../src/presentation/trpc';

const suffix = randomUUID().slice(0, 8);
const seedDb = db as unknown as DatabaseTransaction;
const users: string[] = [];
const tokenIds: string[] = [];
const institutionIds: string[] = [];

type User = typeof schema.users.$inferSelect;
let user: User;
let currency: string;
let cryptoHoldingId: string;
let stockHoldingId: string;

const ACQUIRED_CRYPTO = new Date('2026-01-05T00:00:00Z');
const ACQUIRED_STOCK = new Date('2026-02-05T00:00:00Z');

async function typeId(code: string): Promise<string> {
  const [found] = await db
    .select({ id: schema.tokenTypes.id })
    .from(schema.tokenTypes)
    .where(eq(schema.tokenTypes.code, code));
  if (found) return found.id;
  const [made] = await db
    .insert(schema.tokenTypes)
    .values({ code, name: code })
    .returning({ id: schema.tokenTypes.id });
  if (!made) throw new Error(`token type ${code}`);
  return made.id;
}

async function price(tokenId: string, baseTokenId: string, value: string, at: Date) {
  await db
    .insert(schema.tokenPrices)
    .values({ tokenId, baseTokenId, price: value, timestamp: at, source: 'test-fixture' });
}

async function holdingWithDeposit(opts: {
  accountId: string;
  tokenId: string;
  quantity: string;
  at: Date;
}): Promise<string> {
  const holding = await makeHolding(seedDb, {
    userId: user.id,
    accountId: opts.accountId,
    tokenId: opts.tokenId,
    balance: opts.quantity,
  });
  await db.insert(schema.holdingTransactions).values({
    userId: user.id,
    holdingId: holding.id,
    tokenId: opts.tokenId,
    kind: 'deposit',
    quantity: opts.quantity,
    occurredAt: opts.at,
    source: 'test-fixture',
    externalId: randomUUID(),
  });
  return holding.id;
}

function tool(name: string) {
  const found = MCP_TOOLS.find((t) => t.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
}

async function run(name: string, args: Record<string, unknown> = {}) {
  const t = tool(name);
  const caller = appRouter.createCaller(createAgentContext(user, 'test-token'));
  // biome-ignore lint/suspicious/noExplicitAny: tool outputs are untyped JSON for a model
  return (await t.run(caller, t.input.parse(args))) as any;
}

async function appHoldings(): Promise<HoldingWithDetails[]> {
  const caller = appRouter.createCaller(createAgentContext(user, 'test-token'));
  return (await caller.holdings.getWithDetails()).holdings;
}

beforeAll(async () => {
  setSessionRevokeLimiterForContext(
    new InMemoryInflowRateLimiter({ windowMs: 60_000, max: 1000, namespace: `rl:t-${suffix}` })
  );
  currency = `B${suffix.toUpperCase()}`;
  const base = await makeToken(seedDb, {
    symbol: currency,
    name: 'SC-1616 base',
    typeId: await typeId('fiat'),
  });
  const crypto = await makeToken(seedDb, { symbol: `C${suffix.toUpperCase()}` });
  const stock = await makeToken(seedDb, {
    symbol: `S${suffix.toUpperCase()}`,
    typeId: await typeId('stock'),
  });
  tokenIds.push(crypto.id, stock.id, base.id);

  const [row] = await db
    .insert(schema.users)
    .values({
      email: `sc1616-${suffix}@scani.local`,
      name: 'SC-1616',
      baseCurrencyId: base.id,
    })
    .returning();
  if (!row) throw new Error('user insert failed');
  user = row;
  users.push(user.id);

  const type = await makeInstitutionType(seedDb, { code: 'bank' });
  const institution = await makeInstitution(seedDb, {
    typeId: type.id,
    name: `sc1616-bank-${suffix}`,
  });
  institutionIds.push(institution.id);
  const account = await makeAccount(seedDb, {
    userId: user.id,
    institutionId: institution.id,
    name: `sc1616-account-${suffix}`,
  });

  await price(crypto.id, base.id, '50', ACQUIRED_CRYPTO);
  await price(stock.id, base.id, '30', ACQUIRED_STOCK);
  const now = new Date();
  await price(crypto.id, base.id, '100', now);
  await price(stock.id, base.id, '20', now);

  cryptoHoldingId = await holdingWithDeposit({
    accountId: account.id,
    tokenId: crypto.id,
    quantity: '10',
    at: ACQUIRED_CRYPTO,
  });
  stockHoldingId = await holdingWithDeposit({
    accountId: account.id,
    tokenId: stock.id,
    quantity: '5',
    at: ACQUIRED_STOCK,
  });
  await holdingWithDeposit({
    accountId: account.id,
    tokenId: base.id,
    quantity: '300',
    at: ACQUIRED_CRYPTO,
  });
});

afterAll(async () => {
  await db.delete(schema.users).where(inArray(schema.users.id, users));
  await db.delete(schema.institutions).where(inArray(schema.institutions.id, institutionIds));
  await db.delete(schema.tokenPrices).where(inArray(schema.tokenPrices.tokenId, tokenIds));
  await db.delete(schema.tokens).where(inArray(schema.tokens.id, tokenIds));
});

describe('suggestion tools state the app’s own figures (SC-1616)', () => {
  test('the fixture is priced — a control, so nothing below passes on empty values', async () => {
    const values = (await appHoldings()).map((h) => h.value).sort((a, b) => (b ?? 0) - (a ?? 0));
    expect(values).toEqual([1000, 300, 100]);
  });

  test('get_portfolio_analysis: every value, weight base and gain is the app’s', async () => {
    const app = await appHoldings();
    const out = await run('get_portfolio_analysis');

    expect(out.currency).toBe(currency);
    expect(out.totalValue).toBe(holdingsValue(app));
    expect(out.byAssetType.map((t: { value: number }) => t.value)).toEqual(
      holdingTypeTotals(app).map((t) => t.value)
    );
    for (const row of out.holdings) {
      const h = app.find((a) => a.id === row.id);
      expect(h).toBeDefined();
      if (!h) continue;
      expect(row.value).toBe(h.value);
      expect(row.costBasis).toBe(h.costBasis);
      expect(row.unrealisedGain).toBe(holdingGainLoss(h, currency)?.absolute);
    }
    expect(out.grossAssets).toBe(1400);
    expect(out.concentration.largestPct).toBe(71.43);
    expect(out.cashPct).toBe(21.43);
  });

  test('get_open_lots: the lot is the acquisition, at the app’s price', async () => {
    const app = await appHoldings();
    const out = await run('get_open_lots', { holding_ids: [cryptoHoldingId, stockHoldingId] });
    const crypto = out.holdings.find((h: { holdingId: string }) => h.holdingId === cryptoHoldingId);
    const stock = out.holdings.find((h: { holdingId: string }) => h.holdingId === stockHoldingId);

    expect(crypto.lots).toHaveLength(1);
    expect(Number(crypto.lots[0].quantity)).toBe(10);
    expect(Number(crypto.lots[0].cost)).toBe(500);
    // A decimal string, like every money figure a tool answers with (SC-1648).
    expect(crypto.lots[0].unrealisedGain).toBe('500');
    expect(crypto.price).toBe(app.find((h) => h.id === cryptoHoldingId)?.price?.value);
    expect(Number(crypto.openQuantity)).toBe(
      Number(app.find((h) => h.id === cryptoHoldingId)?.amount)
    );
    expect(Number(crypto.costBasis)).toBe(500);

    expect(Number(stock.lots[0].cost)).toBe(150);
    expect(stock.lots[0].unrealisedGain).toBe('-50');
  });

  test('plan_rebalance: drift and trades from the app’s values', async () => {
    const out = await run('plan_rebalance', {
      group_by: 'asset_type',
      targets: [
        { key: 'crypto', percent: 50 },
        { key: 'stock', percent: 50 },
      ],
    });
    const by = (key: string) => out.rows.find((r: { key: string }) => r.key === key);
    expect(by('crypto')).toMatchObject({ value: 1000, action: 'sell', tradeValue: 300 });
    expect(by('stock')).toMatchObject({ value: 100, action: 'buy', tradeValue: 600 });
    expect(by('fiat')).toMatchObject({ value: 300, targetPct: 0, action: 'sell', tradeValue: 300 });
  });

  test('plan_rebalance: targets that do not sum to 100 are refused', async () => {
    const out = await run('plan_rebalance', {
      group_by: 'asset_type',
      targets: [{ key: 'crypto', percent: 60 }],
    });
    expect(out.error).toContain('60%');
  });

  test('get_suggestions: trims and cash ideas carry the app’s values', async () => {
    const out = await run('get_suggestions', { max_position_pct: 50, max_cash_pct: 10 });
    const trim = out.ideas.find((i: { kind: string }) => i.kind === 'trim');
    expect(trim).toMatchObject({ holdingId: cryptoHoldingId, value: 1000, sellValue: 300 });
    expect(trim.sellQuantity).toBe(3);
    const cash = out.ideas.find((i: { kind: string }) => i.kind === 'deploy_cash');
    expect(cash).toMatchObject({ cashValue: 300, investValue: 160 });
  });
});
