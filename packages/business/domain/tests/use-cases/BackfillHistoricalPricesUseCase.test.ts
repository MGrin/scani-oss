/**
 * `BackfillHistoricalPricesUseCase` integration tests.
 *
 * Same isolation strategy as `LinkTransferPairsUseCase.test.ts`: this
 * use case calls the global `db` directly and `HistoricalPriceBackfillService`
 * (which we stub to avoid live HTTP), so we manage isolation by:
 *
 *   - Inserting a fresh user + holdings + tokens per test.
 *   - Stubbing `HistoricalPriceBackfillService` on the typedi
 *     Container so the use case's per-candidate calls record into a
 *     buffer instead of dispatching to real providers.
 *   - Cleaning up via cascade-delete on the user in `afterEach`.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { Container } from 'typedi';
import {
  type BackfillOneResult,
  HistoricalPriceBackfillService,
} from '../../src/services/pricing/HistoricalPriceBackfillService';
import { BackfillHistoricalPricesUseCase } from '../../src/use-cases/BackfillHistoricalPricesUseCase';

interface Fixture {
  userId: string;
  accountId: string;
  usdTokenId: string;
  btcTokenId: string;
  holdingId: string;
  // Lookup-table row ids — explicitly tracked so cleanupFixture can
  // remove them too. They don't FK to user, so cascade-deleting the
  // user leaves them behind and pollutes the dev DB across runs.
  institutionTypeId: string;
  institutionId: string;
  accountTypeId: string;
  tokenTypeId: string;
}

let fixture: Fixture | null = null;
let backfillCalls: Array<{ tokenId: string; at: Date; baseTokenId: string }> = [];
// Per-call result the stubbed service returns. Tests can override.
let nextResult: (tokenId: string, at: Date, baseTokenId: string) => BackfillOneResult = (
  tokenId,
  at,
  baseTokenId
) => ({
  tokenId,
  baseTokenId,
  at,
  status: 'inserted',
  priceStored: '50000',
  providerUsed: 'stub',
});

async function setupFixture(): Promise<Fixture> {
  const [user] = await db
    .insert(schema.users)
    .values({ email: `bhp-${randomUUID().slice(0, 8)}@scani.local`, name: 'BackfillTest' })
    .returning();
  if (!user) throw new Error('user insert failed');

  const [instType] = await db
    .insert(schema.institutionTypes)
    .values({ code: `bhp-${randomUUID().slice(0, 6)}`, name: 'BHP Type' })
    .returning();
  const [inst] = await db
    .insert(schema.institutions)
    .values({ name: `BHP-${randomUUID().slice(0, 6)}`, typeId: instType!.id })
    .returning();
  const [acctType] = await db
    .insert(schema.accountTypes)
    .values({ code: `bhp-acct-${randomUUID().slice(0, 6)}`, name: 'BHP Account' })
    .returning();
  const [account] = await db
    .insert(schema.accounts)
    .values({
      userId: user.id,
      institutionId: inst!.id,
      typeId: acctType!.id,
      name: `bhp-${randomUUID().slice(0, 6)}`,
    })
    .returning();
  if (!account) throw new Error('account insert failed');

  const [tokenType] = await db
    .insert(schema.tokenTypes)
    .values({ code: `bhp-tok-${randomUUID().slice(0, 6)}`, name: 'BHP Token Type' })
    .returning();
  const [usdToken] = await db
    .insert(schema.tokens)
    .values({
      symbol: `BHPUSD${randomUUID().slice(0, 4).toUpperCase()}`,
      name: 'BHP USD',
      typeId: tokenType!.id,
    })
    .returning();
  const [btcToken] = await db
    .insert(schema.tokens)
    .values({
      symbol: `BHPBTC${randomUUID().slice(0, 4).toUpperCase()}`,
      name: 'BHP BTC',
      typeId: tokenType!.id,
    })
    .returning();
  if (!usdToken || !btcToken) throw new Error('token insert failed');

  const [holding] = await db
    .insert(schema.holdings)
    .values({
      userId: user.id,
      accountId: account.id,
      tokenId: btcToken.id,
      balance: '1',
    })
    .returning();
  if (!holding) throw new Error('holding insert failed');

  return {
    userId: user.id,
    accountId: account.id,
    usdTokenId: usdToken.id,
    btcTokenId: btcToken.id,
    holdingId: holding.id,
    institutionTypeId: instType!.id,
    institutionId: inst!.id,
    accountTypeId: acctType!.id,
    tokenTypeId: tokenType!.id,
  };
}

async function cleanupFixture(f: Fixture): Promise<void> {
  // User cascade only cleans accounts/holdings/transactions — the
  // lookup-table rows we created don't FK to user, so we have to
  // delete them explicitly in dependency order. Without this, every
  // test run leaks `account_types` / `institution_types` / `token_types`
  // rows that pollute the dev DB enum dropdowns.
  //
  // `token_prices.base_token_id` has ON DELETE RESTRICT (a fiat token
  // shouldn't disappear while prices reference it). Tests that write
  // historical prices for our tokens-as-base have to clear the price
  // rows before the token rows, so we wipe both base_token and token
  // references regardless of which test wrote them.
  await db.delete(schema.users).where(eq(schema.users.id, f.userId));
  const tokenIds = [f.usdTokenId, f.btcTokenId];
  await db.delete(schema.tokenPrices).where(inArray(schema.tokenPrices.baseTokenId, tokenIds));
  await db.delete(schema.tokenPrices).where(inArray(schema.tokenPrices.tokenId, tokenIds));
  await db.delete(schema.tokens).where(inArray(schema.tokens.id, tokenIds));
  await db.delete(schema.tokenTypes).where(eq(schema.tokenTypes.id, f.tokenTypeId));
  await db.delete(schema.accountTypes).where(eq(schema.accountTypes.id, f.accountTypeId));
  await db.delete(schema.institutions).where(eq(schema.institutions.id, f.institutionId));
  await db
    .delete(schema.institutionTypes)
    .where(eq(schema.institutionTypes.id, f.institutionTypeId));
}

beforeEach(async () => {
  fixture = await setupFixture();
  backfillCalls = [];

  // Stub HistoricalPriceBackfillService so we capture invocations
  // without making HTTP calls. The use case now fans out per-token via
  // backfillTokenRange, so the stub aggregates per-day nextResult()
  // outcomes into the new return shape — keeps the existing scenario
  // helpers (nextResult queue) working without rewriting every test.
  const stub = {
    backfillOne: async (tokenId: string, at: Date, baseTokenId: string) => {
      backfillCalls.push({ tokenId, at, baseTokenId });
      return nextResult(tokenId, at, baseTokenId);
    },
    backfillTokenRange: async (tokenId: string, baseTokenId: string, neededDays: Date[]) => {
      let inserted = 0;
      let alreadyHad = 0;
      let providerMissing = 0;
      let providerUsed: string | null = null;
      for (const day of neededDays) {
        backfillCalls.push({ tokenId, at: day, baseTokenId });
        // Mirror production: per-day exceptions are swallowed by the
        // provider's tryPerDayFetch (Promise.allSettled) and counted
        // as provider-missing for that day rather than failing the
        // whole token batch.
        try {
          const result = nextResult(tokenId, day, baseTokenId);
          if (result.status === 'inserted') {
            inserted++;
            providerUsed = result.providerUsed ?? providerUsed;
          } else if (result.status === 'already-have') {
            alreadyHad++;
          } else {
            providerMissing++;
          }
        } catch {
          providerMissing++;
        }
      }
      return { inserted, alreadyHad, providerMissing, providerUsed };
    },
  } as unknown as HistoricalPriceBackfillService;
  Container.set(HistoricalPriceBackfillService, stub);

  // Reset use case so its class-field initializer captures the stub.
  Container.set(BackfillHistoricalPricesUseCase, new BackfillHistoricalPricesUseCase());
});

afterEach(async () => {
  if (fixture) await cleanupFixture(fixture);
  fixture = null;
});

// Restore real @Service() instances so a later repo/service test sharing
// the process-global typedi Container doesn't pick up our stub.
afterAll(() => {
  Container.set(HistoricalPriceBackfillService, new HistoricalPriceBackfillService());
  Container.set(BackfillHistoricalPricesUseCase, new BackfillHistoricalPricesUseCase());
});

describe('BackfillHistoricalPricesUseCase', () => {
  test('throws when called without usdTokenId', async () => {
    const uc = Container.get(BackfillHistoricalPricesUseCase);
    await expect(uc.execute({ usdTokenId: '' })).rejects.toThrow(/requires opts.usdTokenId/);
  });

  test('produces no work when no held / transacted tokens exist for the user', async () => {
    const f = fixture!;
    // Wipe holdings inserted by setupFixture so the user has nothing held.
    await db.delete(schema.holdings).where(eq(schema.holdings.id, f.holdingId));
    // Tiny lookback so we don't iterate years of empty days.
    const summary = await Container.get(BackfillHistoricalPricesUseCase).execute({
      usdTokenId: f.usdTokenId,
      lookbackDays: 1,
    });
    // No tokens to price → zero attempts.
    expect(summary.attempted).toBe(0);
    expect(summary.inserted).toBe(0);
    expect(backfillCalls).toHaveLength(0);
  });

  test('attempts a backfill for each held token across each day in the lookback window', async () => {
    const f = fixture!;
    // The use case walks `sinceDay..todayDay` inclusive, so
    // `lookbackDays=3` yields 4 candidate days (today + 3 prior).
    const summary = await Container.get(BackfillHistoricalPricesUseCase).execute({
      usdTokenId: f.usdTokenId,
      lookbackDays: 3,
    });
    expect(summary.attempted).toBe(4);
    expect(summary.inserted).toBe(4);
    // Every call addressed the BTC token in USD.
    expect(backfillCalls.every((c) => c.tokenId === f.btcTokenId)).toBe(true);
    expect(backfillCalls.every((c) => c.baseTokenId === f.usdTokenId)).toBe(true);
  });

  test('skips dates that already have a daily-granularity price row', async () => {
    const f = fixture!;
    // Pre-seed today's price so the use case skips it. The cache check
    // is "daily granularity, ±24h of `at`".
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    await db.insert(schema.tokenPrices).values({
      tokenId: f.btcTokenId,
      baseTokenId: f.usdTokenId,
      price: '42000',
      timestamp: today,
      source: 'preseeded',
      granularity: 'daily',
    });

    const summary = await Container.get(BackfillHistoricalPricesUseCase).execute({
      usdTokenId: f.usdTokenId,
      lookbackDays: 3,
    });
    // 4 candidate days minus one already covered → 3 attempts.
    expect(summary.attempted).toBe(3);
    expect(backfillCalls).toHaveLength(3);
  });

  test('classifies the result by status — counts inserted / already-had / provider-missing separately', async () => {
    const f = fixture!;
    let counter = 0;
    nextResult = (tokenId, at, baseTokenId) => {
      counter += 1;
      // Cycle through 4 results to cover the 4 candidate days.
      if (counter === 1) {
        return { tokenId, baseTokenId, at, status: 'inserted', priceStored: '1' };
      }
      if (counter === 2) {
        return { tokenId, baseTokenId, at, status: 'already-have' };
      }
      if (counter === 3) {
        return { tokenId, baseTokenId, at, status: 'provider-missing' };
      }
      return { tokenId, baseTokenId, at, status: 'inserted', priceStored: '2' };
    };
    const summary = await Container.get(BackfillHistoricalPricesUseCase).execute({
      usdTokenId: f.usdTokenId,
      lookbackDays: 3,
    });
    expect(summary.attempted).toBe(4);
    expect(summary.inserted).toBe(2);
    expect(summary.alreadyHad).toBe(1);
    expect(summary.providerMissing).toBe(1);
  });

  test('continues past per-candidate exceptions (counts them as provider-missing)', async () => {
    const f = fixture!;
    let counter = 0;
    nextResult = ((_tokenId, _at, _baseTokenId): BackfillOneResult => {
      counter += 1;
      if (counter === 2) throw new Error('upstream 500');
      return {
        tokenId: f.btcTokenId,
        baseTokenId: f.usdTokenId,
        at: new Date(),
        status: 'inserted',
        priceStored: '1',
      };
    }) as typeof nextResult;
    const summary = await Container.get(BackfillHistoricalPricesUseCase).execute({
      usdTokenId: f.usdTokenId,
      lookbackDays: 3,
    });
    // 4 attempts; one threw → 3 inserted, 1 provider-missing.
    expect(summary.attempted).toBe(4);
    expect(summary.inserted).toBe(3);
    expect(summary.providerMissing).toBe(1);
  });
});
