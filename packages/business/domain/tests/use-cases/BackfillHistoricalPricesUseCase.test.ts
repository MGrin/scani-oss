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

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { ProviderRegistry } from '@scani/providers/core/registry';
import { eq, inArray } from 'drizzle-orm';
import { Container } from 'typedi';
import {
  type BackfillOneResult,
  HistoricalPriceBackfillService,
} from '../../src/services/pricing/HistoricalPriceBackfillService';
import { BackfillHistoricalPricesUseCase } from '../../src/use-cases/BackfillHistoricalPricesUseCase';
import { restoreContainerAfterAll } from '../../test/helpers/container';

// Container stubs are process-global; put back whatever this file changes
// so no later test file resolves them (SC-448).
restoreContainerAfterAll();

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
// Stands in for a provider that ERRORED rather than answering — the
// distinction `attemptFailed` exists to carry (SC-171).
let nextAttemptFailed = false;
// Per-call result the stubbed service returns. Tests can override.
/**
 * SC-449. Hoisted out of `nextResult` so `beforeEach` has something to put
 * back. Nine tests below reassign `nextResult`, and the assignment outlives
 * the test that made it — the test asserting `summary.inserted === 4` then
 * runs against a sibling's stub that returns no insert, and reads 0.
 */
const DEFAULT_RESULT: (tokenId: string, at: Date, baseTokenId: string) => BackfillOneResult = (
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

let nextResult = DEFAULT_RESULT;

/**
 * EVERY `execute` BELOW PASSES `userId`, AND IT IS LOAD-BEARING (SC-230).
 *
 * The use case discovers candidates from holdings and transactions, and
 * without `opts.userId` it discovers them across the WHOLE database. These
 * tests then assert absolute numbers — `skippedUnpriceable` is 1, `attempted`
 * is 0 — against a shared local Postgres that also holds dev data and every
 * other suite's fixtures.
 *
 * `skips tokens still inside an unpriceable cooldown` failed for exactly that
 * reason: it marks its own BTC unpriceable and expects a count of 1, while 22
 * unrelated rows in the same database carry `unpriceable_until` from real
 * work. The assertion was measuring the machine, not the code, so it passed
 * on a fresh scratch database and failed on one with history — which is how
 * two people ran the same suite and reported different results to each other.
 *
 * Scoping to the fixture's own user makes every count mean what it says.
 *
 * **This paragraph was false for four calls when SC-272 was filed**, including
 * `planOnly`, whose `expect(summary.attempted).toBe(4)` read the whole table
 * and returned 16 against a database holding one neighbouring user. Two
 * threads lost time to it in a day, each proving the failure was not theirs.
 * So the claim is now checked rather than asserted — see the guard at the
 * bottom of this file. A comment is what failed here; do not add another in
 * place of one.
 */
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
      symbol: `BHPUSD${randomUUID().toUpperCase()}`,
      name: 'BHP USD',
      typeId: tokenType!.id,
    })
    .returning();
  const [btcToken] = await db
    .insert(schema.tokens)
    .values({
      symbol: `BHPBTC${randomUUID().toUpperCase()}`,
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
  nextAttemptFailed = false;
  // SC-449. The two above were already reset here; this one was missed, and it
  // is the one that decides what the use case reports as inserted.
  nextResult = DEFAULT_RESULT;

  // A registry with one historical pricer — what a booted process looks
  // like. Without it every test runs in the "nobody was asked" state the
  // no-provider guard refuses to mark from, which is correct behaviour and
  // the wrong precondition for testing what a real run does (SC-171).
  Container.set(ProviderRegistry, {
    getAllHistoricalPricers: () => [{ providerKey: 'stub' }],
  } as unknown as ProviderRegistry);

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
      return {
        inserted,
        alreadyHad,
        providerMissing,
        providerUsed,
        attemptFailed: nextAttemptFailed,
      };
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
      userId: f.userId,
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
      userId: f.userId,
      usdTokenId: f.usdTokenId,
      lookbackDays: 3,
    });
    expect(summary.attempted).toBe(4);
    expect(summary.inserted).toBe(4);
    // Every call addressed the BTC token in USD.
    expect(backfillCalls.every((c) => c.tokenId === f.btcTokenId)).toBe(true);
    expect(backfillCalls.every((c) => c.baseTokenId === f.usdTokenId)).toBe(true);
  });

  /**
   * `planOnly` — what `scripts/run-historical-price-backfill.ts` reads out
   * before it is allowed to touch a provider (SC-171).
   *
   * The property that matters is not the shape of the plan, it is that
   * producing it costs nothing: an operator asking "what would this do"
   * against production must not be the thing that does it.
   */
  test('planOnly returns the per-token windows and calls no provider', async () => {
    const f = fixture!;
    const summary = await Container.get(BackfillHistoricalPricesUseCase).execute({
      userId: f.userId,
      usdTokenId: f.usdTokenId,
      lookbackDays: 3,
      planOnly: true,
    });

    expect(backfillCalls).toHaveLength(0);
    expect(summary.inserted).toBe(0);
    expect(summary.attempted).toBe(4);

    const entry = summary.plan?.find((p) => p.tokenId === f.btcTokenId);
    expect(entry?.missingDays).toBe(4);
    // Inclusive bounds over today + 3 prior days.
    const spanDays = ((entry?.to?.getTime() ?? 0) - (entry?.from?.getTime() ?? 0)) / 86_400_000;
    expect(spanDays).toBe(3);
  });

  test('the plan describes exactly the work the real run then does', async () => {
    // A plan derived differently from the run is a plan about a different
    // run. Same options, both paths, and the day count has to agree — this
    // is what makes the dry run evidence rather than decoration.
    const f = fixture!;
    const opts = { userId: f.userId, usdTokenId: f.usdTokenId, lookbackDays: 3 };
    const planned = await Container.get(BackfillHistoricalPricesUseCase).execute({
      ...opts,
      planOnly: true,
    });
    const ran = await Container.get(BackfillHistoricalPricesUseCase).execute(opts);

    const plannedDays = (planned.plan ?? []).reduce((n, p) => n + p.missingDays, 0);
    expect(plannedDays).toBe(ran.attempted);
    expect(backfillCalls).toHaveLength(plannedDays);
  });

  test('planOnly still reports what it would skip for a cooldown', async () => {
    // Otherwise a plan of zero tokens reads as "nothing to do" when the
    // truth is "everything is suppressed" — the exact confusion the
    // unpriceable ratchet lived inside for months.
    const f = fixture!;
    await db
      .update(schema.tokens)
      .set({ unpriceableUntil: new Date(Date.now() + 60_000) })
      .where(eq(schema.tokens.id, f.btcTokenId));

    const summary = await Container.get(BackfillHistoricalPricesUseCase).execute({
      // Scoped, like every other call in this file (SC-230). Without it the
      // use case discovers candidates across the whole shared database and
      // `skippedUnpriceable` counts the 22 unrelated rows that carry a real
      // `unpriceable_until`, so this assertion measures the machine.
      userId: f.userId,
      usdTokenId: f.usdTokenId,
      lookbackDays: 3,
      planOnly: true,
    });

    expect(summary.plan).toEqual([]);
    expect(summary.skippedUnpriceable).toBe(1);
    expect(backfillCalls).toHaveLength(0);
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
      userId: f.userId,
      usdTokenId: f.usdTokenId,
      lookbackDays: 3,
    });
    // 4 candidate days minus one already covered → 3 attempts and 1 already-had.
    expect(summary.attempted).toBe(3);
    expect(summary.alreadyHad).toBe(1);
    expect(backfillCalls).toHaveLength(3);
  });

  test('classifies the result by status — counts inserted / already-had / provider-missing separately', async () => {
    const f = fixture!;
    // Pre-seed one day's price so the use-case-level dedup picks it up.
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
    let counter = 0;
    nextResult = (tokenId, at, baseTokenId) => {
      counter += 1;
      // 3 days will reach the stub (today is pre-seeded). One returns
      // provider-missing, the rest insert.
      if (counter === 1) {
        return { tokenId, baseTokenId, at, status: 'provider-missing' };
      }
      return { tokenId, baseTokenId, at, status: 'inserted', priceStored: '1' };
    };
    const summary = await Container.get(BackfillHistoricalPricesUseCase).execute({
      userId: f.userId,
      usdTokenId: f.usdTokenId,
      lookbackDays: 3,
    });
    expect(summary.attempted).toBe(3); // 4 candidates - 1 pre-seeded
    expect(summary.alreadyHad).toBe(1);
    expect(summary.inserted).toBe(2);
    expect(summary.providerMissing).toBe(1);
  });

  test('skips tokens still inside an unpriceable cooldown', async () => {
    const f = fixture!;
    // Mark BTC as unpriceable until far in the future.
    const farFuture = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await db
      .update(schema.tokens)
      .set({ unpriceableUntil: farFuture })
      .where(eq(schema.tokens.id, f.btcTokenId));

    const summary = await Container.get(BackfillHistoricalPricesUseCase).execute({
      userId: f.userId,
      usdTokenId: f.usdTokenId,
      lookbackDays: 3,
    });

    expect(summary.skippedUnpriceable).toBe(1);
    expect(summary.attempted).toBe(0);
    expect(backfillCalls).toHaveLength(0);
  });

  test('marks a token unpriceable when its full range returns no quotes', async () => {
    const f = fixture!;
    // Lookback of 60 days is above the UNPRICEABLE_MIN_RANGE_DAYS floor (30).
    nextResult = (tokenId, at, baseTokenId) => ({
      tokenId,
      baseTokenId,
      at,
      status: 'provider-missing',
    });
    const summary = await Container.get(BackfillHistoricalPricesUseCase).execute({
      userId: f.userId,
      usdTokenId: f.usdTokenId,
      lookbackDays: 60,
    });
    expect(summary.inserted).toBe(0);
    expect(summary.providerMissing).toBeGreaterThan(0);
    const [token] = await db
      .select({ unpriceableUntil: schema.tokens.unpriceableUntil })
      .from(schema.tokens)
      .where(eq(schema.tokens.id, f.btcTokenId));
    expect(token?.unpriceableUntil).toBeInstanceOf(Date);
    expect(token!.unpriceableUntil!.getTime()).toBeGreaterThan(Date.now());
  });

  /**
   * The assertion the whole of SC-171 reduces to.
   *
   * DeFiLlama's `/chart` refuses spans over 500 points, we asked for up
   * to 1825, and the resulting HTTP 400 came back as an empty range.
   * Empty meant "no price history", which meant a 7-day unpriceable
   * cooldown, which meant the token was skipped before it could be
   * retried — and re-marked when it finally was. Many tokens sat in that
   * state in production, including major ones, a batch of them stamped by a
   * single run to the millisecond.
   *
   * A run that never got an answer must not produce a verdict.
   */
  test('does NOT mark a token unpriceable when the provider ERRORED rather than answered', async () => {
    const f = fixture!;
    nextAttemptFailed = true;
    nextResult = (tokenId, at, baseTokenId) => ({
      tokenId,
      baseTokenId,
      at,
      status: 'provider-missing',
    });
    // 60 days is well past the 30-day floor, so the ONLY thing standing
    // between this token and a cooldown is the failed-attempt check.
    const summary = await Container.get(BackfillHistoricalPricesUseCase).execute({
      userId: f.userId,
      usdTokenId: f.usdTokenId,
      lookbackDays: 60,
    });
    expect(summary.inserted).toBe(0);
    expect(summary.attemptsFailed).toBeGreaterThan(0);
    const [token] = await db
      .select({ unpriceableUntil: schema.tokens.unpriceableUntil })
      .from(schema.tokens)
      .where(eq(schema.tokens.id, f.btcTokenId));
    expect(token?.unpriceableUntil).toBeNull();
  });

  /**
   * "Nobody to ask" is not "nobody has it" (SC-171, second time).
   *
   * A process that never registered a historical pricer answers every day
   * with `providerMissing`, which is indistinguishable from five providers
   * having genuinely missed — and `inserted === 0` past the floor then marks
   * every token unpriceable for a week. A one-shot runner missing
   * `buildProviderRegistry` did exactly that to ETH, BTC, SOL, USDC and MATIC
   * against production, in 1.4 seconds, without one HTTP call.
   */
  test('does NOT mark a token unpriceable when no provider was registered at all', async () => {
    const f = fixture!;
    const registry = Container.get(ProviderRegistry);
    // A registry with no historical pricers — the boot mistake, in miniature.
    Container.set(ProviderRegistry, {
      getAllHistoricalPricers: () => [],
    } as unknown as ProviderRegistry);
    nextResult = (tokenId, at, baseTokenId) => ({
      tokenId,
      baseTokenId,
      at,
      status: 'provider-missing',
    });

    try {
      const summary = await Container.get(BackfillHistoricalPricesUseCase).execute({
        userId: f.userId,
        usdTokenId: f.usdTokenId,
        // Past UNPRICEABLE_MIN_RANGE_DAYS, so the registry check is the only
        // thing standing between this token and a week-long cooldown.
        lookbackDays: 60,
      });
      expect(summary.inserted).toBe(0);

      const [token] = await db
        .select({ unpriceableUntil: schema.tokens.unpriceableUntil })
        .from(schema.tokens)
        .where(eq(schema.tokens.id, f.btcTokenId));
      expect(token?.unpriceableUntil ?? null).toBeNull();
    } finally {
      Container.set(ProviderRegistry, registry);
    }
  });

  /**
   * A cooldown only means anything for a token we have NEVER priced (SC-232).
   *
   * The read side already encodes this: `findNeverPricedInCooldownTokenIds`
   * — consulted by the rollup, holdings and valuation — carries
   * `NOT EXISTS (SELECT 1 FROM token_prices ...)` in its WHERE. The write
   * side did not, so a token with thousands of stored rows could be removed
   * from the nightly backfill for a week by a residual gap nobody covers.
   * ETH carried exactly that, holding 1,956 rows back to 2021.
   */
  test('does NOT mark a token unpriceable when it already has stored prices', async () => {
    const f = fixture!;
    // One price row, far outside the requested window — enough to make the
    // token "priced" for the purpose the cooldown serves.
    await db.insert(schema.tokenPrices).values({
      tokenId: f.btcTokenId,
      baseTokenId: f.usdTokenId,
      price: '30000',
      timestamp: new Date('2021-09-06T00:00:00Z'),
      source: 'preseeded',
      granularity: 'daily',
    });
    nextResult = (tokenId, at, baseTokenId) => ({
      tokenId,
      baseTokenId,
      at,
      status: 'provider-missing',
    });

    const summary = await Container.get(BackfillHistoricalPricesUseCase).execute({
      userId: f.userId,
      usdTokenId: f.usdTokenId,
      // Past the 30-day floor, so the stored-price check is the only thing
      // between this token and a week-long cooldown.
      lookbackDays: 60,
    });
    expect(summary.inserted).toBe(0);

    const [token] = await db
      .select({ unpriceableUntil: schema.tokens.unpriceableUntil })
      .from(schema.tokens)
      .where(eq(schema.tokens.id, f.btcTokenId));
    expect(token?.unpriceableUntil ?? null).toBeNull();
  });

  test('does NOT mark a token unpriceable when the range is shorter than the floor', async () => {
    const f = fixture!;
    nextResult = (tokenId, at, baseTokenId) => ({
      tokenId,
      baseTokenId,
      at,
      status: 'provider-missing',
    });
    // 5 days < 30-day floor, so even with 0 inserted we don't blocklist.
    await Container.get(BackfillHistoricalPricesUseCase).execute({
      userId: f.userId,
      usdTokenId: f.usdTokenId,
      lookbackDays: 5,
    });
    const [token] = await db
      .select({ unpriceableUntil: schema.tokens.unpriceableUntil })
      .from(schema.tokens)
      .where(eq(schema.tokens.id, f.btcTokenId));
    expect(token?.unpriceableUntil).toBeNull();
  });

  test('clears unpriceable cooldown on a successful backfill', async () => {
    const f = fixture!;
    // Pre-mark as unpriceable but with an already-elapsed cooldown so
    // the use case still considers the token (otherwise it would just
    // skip and we'd never test the clear path).
    const past = new Date(Date.now() - 1000);
    await db
      .update(schema.tokens)
      .set({ unpriceableUntil: past })
      .where(eq(schema.tokens.id, f.btcTokenId));
    nextResult = (tokenId, at, baseTokenId) => ({
      tokenId,
      baseTokenId,
      at,
      status: 'inserted',
      priceStored: '1',
    });
    await Container.get(BackfillHistoricalPricesUseCase).execute({
      userId: f.userId,
      usdTokenId: f.usdTokenId,
      lookbackDays: 3,
    });
    const [token] = await db
      .select({ unpriceableUntil: schema.tokens.unpriceableUntil })
      .from(schema.tokens)
      .where(eq(schema.tokens.id, f.btcTokenId));
    expect(token?.unpriceableUntil).toBeNull();
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
      userId: f.userId,
      usdTokenId: f.usdTokenId,
      lookbackDays: 3,
    });
    // 4 attempts; one threw → 3 inserted, 1 provider-missing.
    expect(summary.attempted).toBe(4);
    expect(summary.inserted).toBe(3);
    expect(summary.providerMissing).toBe(1);
  });
});

/**
 * SC-229 — where the window comes from when `holding_coverage` has nothing.
 *
 * The per-token start used to read `holding_coverage.first_tx_at` and, on a
 * NULL, fall all the way back to the 1,826-day lookback. The widest window in
 * the run therefore landed on the tokens we knew least about: on a production
 * dry run, a handful of tokens with no coverage row accounted for about half
 * the missing days and about half the provider requests — half a run's budget
 * spent establishing that a set of memecoins has no price feed.
 *
 * The transactions were there the whole time. They are why discovery finds
 * these tokens at all.
 */
describe('BackfillHistoricalPricesUseCase — start date with no coverage row', () => {
  const DAY_MS = 86_400_000;
  const utcDay = (offsetDays: number): Date => {
    const at = new Date(Date.now() - offsetDays * DAY_MS);
    return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  };

  async function addTransaction(f: Fixture, occurredAt: Date, externalId: string): Promise<void> {
    await db.insert(schema.holdingTransactions).values({
      userId: f.userId,
      holdingId: f.holdingId,
      tokenId: f.btcTokenId,
      kind: 'buy',
      quantity: '1',
      occurredAt,
      externalId,
      source: 'statement-csv',
    });
  }

  test('starts at the earliest transaction, not the lookback floor', async () => {
    const f = fixture!;
    await addTransaction(f, utcDay(10), 'sc229-first');
    const summary = await Container.get(BackfillHistoricalPricesUseCase).execute({
      userId: f.userId,
      usdTokenId: f.usdTokenId,
      lookbackDays: 60,
      planOnly: true,
    });
    // 10 days back through today inclusive — not the 61 the lookback gives.
    expect(summary.attempted).toBe(11);
    const [entry] = summary.plan ?? [];
    expect(entry?.from).toEqual(utcDay(10));
    expect(entry?.firstTxAt).toEqual(utcDay(10));
  });

  test('a coverage row still wins over the transactions when it has one', async () => {
    const f = fixture!;
    await addTransaction(f, utcDay(40), 'sc229-old-tx');
    await db.insert(schema.holdingCoverage).values({
      holdingId: f.holdingId,
      firstTxAt: utcDay(3),
      lastTxAt: utcDay(1),
      txSources: ['statement-csv'],
      hasCompleteTxHistory: true,
    });
    const summary = await Container.get(BackfillHistoricalPricesUseCase).execute({
      userId: f.userId,
      usdTokenId: f.usdTokenId,
      lookbackDays: 60,
      planOnly: true,
    });
    // The coverage row is the authority when it exists — 3 days back
    // through today, and NOT the 41 the older transaction would give.
    expect(summary.attempted).toBe(4);
  });

  test('a closed position with no coverage row ends at its last transaction', async () => {
    const f = fixture!;
    await db
      .update(schema.holdings)
      .set({ balance: '0' })
      .where(eq(schema.holdings.id, f.holdingId));
    await addTransaction(f, utcDay(20), 'sc229-open');
    await addTransaction(f, utcDay(10), 'sc229-close');
    const summary = await Container.get(BackfillHistoricalPricesUseCase).execute({
      userId: f.userId,
      usdTokenId: f.usdTokenId,
      lookbackDays: 60,
      planOnly: true,
    });
    // 20 days back through 10 days back, inclusive — the same lifetime
    // bound a coverage row would have given, now reachable without one.
    expect(summary.attempted).toBe(11);
    const [entry] = summary.plan ?? [];
    expect(entry?.from).toEqual(utcDay(20));
    expect(entry?.to).toEqual(utcDay(10));
  });

  /**
   * The dedup window has to move with the start date.
   *
   * `discoverySince` bounds the existing-price query, and a token whose first
   * transaction predates the lookback now starts before it. If that bound did
   * not follow, every already-priced day older than the lookback would read as
   * missing and be requested again — a fix for a cost ticket that costs more.
   */
  test('does not re-request already-priced days that predate the lookback window', async () => {
    const f = fixture!;
    const firstTx = utcDay(70);
    await addTransaction(f, firstTx, 'sc229-ancient');
    await db.insert(schema.tokenPrices).values({
      tokenId: f.btcTokenId,
      baseTokenId: f.usdTokenId,
      timestamp: firstTx,
      price: '50000',
      granularity: 'daily',
      source: 'test',
    });
    const summary = await Container.get(BackfillHistoricalPricesUseCase).execute({
      userId: f.userId,
      usdTokenId: f.usdTokenId,
      lookbackDays: 60,
      planOnly: true,
    });
    expect(summary.alreadyHad).toBe(1);
    const [entry] = summary.plan ?? [];
    expect(entry?.from).toEqual(utcDay(69));
  });
});

/**
 * The invariant at the top of this file, enforced rather than stated (SC-272).
 *
 * SC-230 scoped eleven `execute` calls and left a comment saying every call
 * below passes `userId` and why. The comment was **already false when this
 * ticket was filed**: four calls did not, including `planOnly`, whose
 * `expect(summary.attempted).toBe(4)` reads the whole table. Two threads lost
 * time to it in one day, each proving the failure was not theirs.
 *
 * `docs/technical/2026-08-15_absence-and-refusal.md` predicted this in the
 * entry about SC-230 itself — *"One branch later a new test was added without
 * it, by someone who had read the file. Documentation of an invariant is not
 * enforcement of it."* This is that enforcement, and it is a source check
 * rather than a runtime one because the failure mode is a call that is never
 * written, which no runtime assertion can observe.
 */
describe('every execute in this file is scoped to the fixture user', () => {
  test('no call discovers candidates across the whole database', async () => {
    const source = await Bun.file(import.meta.path).text();
    const unscoped: string[] = [];

    for (const match of source.matchAll(/\.execute\(\s*\{/g)) {
      const start = match.index ?? 0;
      let depth = 0;
      let end = start;
      for (let i = source.indexOf('{', start); i < source.length; i += 1) {
        if (source[i] === '{') depth += 1;
        if (source[i] === '}') depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
      const call = source.slice(start, end + 1);
      // The one legitimate exception: it asserts the guard that throws before
      // any discovery happens, so there is nothing for a user to scope.
      if (call.includes("usdTokenId: ''")) continue;
      if (call.includes('userId')) continue;

      // A spread carries the option in from a shared object, which the plan
      // vs run test needs so both paths provably use the SAME options.
      // Resolved exactly — the declaration must exist and must carry
      // `userId` — rather than accepted on sight, and it fails closed when
      // the declaration cannot be found. A guard that shrugs at what it
      // cannot parse is the shape this file is already an example of.
      const spread = call.match(/\.\.\.(\w+)/);
      if (spread?.[1]) {
        const declaration = source.match(new RegExp(`const ${spread[1]}\\s*=\\s*\\{[^}]*\\}`));
        if (declaration?.[0].includes('userId')) continue;
        unscoped.push(
          declaration
            ? `${spread[1]} is spread in but declared without userId`
            : `${spread[1]} is spread in and its declaration was not found`
        );
        continue;
      }

      unscoped.push(call.replace(/\s+/g, ' ').slice(0, 90));
    }

    expect(unscoped).toEqual([]);
  });
});
