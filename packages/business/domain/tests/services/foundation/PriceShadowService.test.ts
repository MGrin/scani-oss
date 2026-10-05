import { beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { DatabaseTransaction } from '@scani/db';
import type { Token } from '@scani/db/schema';
import * as schema from '@scani/db/schema';
import { Decimal } from '@scani/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { Container } from 'typedi';
import { EngineEvidenceRepository } from '../../../src/repositories/EngineEvidenceRepository';
import { PriceShadowService } from '../../../src/services/foundation/PriceShadowService';
import {
  type PriceGraphConversion,
  type PriceGraphOptions,
  PriceGraphService,
} from '../../../src/services/pricing/PriceGraphService';
import { PricingService } from '../../../src/services/pricing/PricingService';
import { restoreContainerAfterAll } from '../../../test/helpers/container';
import { withTestDb } from '../../../test/helpers/db';
import { makeInstitution, makeUser } from '../../../test/helpers/factories';
import {
  makeAccount,
  makeHolding,
  makeHoldingTransaction,
  makeToken,
} from '../../../test/helpers/factories-extra';
import {
  captureRunIds,
  differencesOf,
  evidenceFingerprint,
  failingShadowUsers,
  onlyUsers,
  runRow,
} from '../../../test/helpers/shadow-runs';

restoreContainerAfterAll();

const at = (iso: string) => new Date(iso);
// Half an hour after the newest readings: inside the live window, so
// `stale-fallback` does not name a difference before the category under test.
const AS_OF = at('2026-03-01T00:30:00Z');
const MAR_1 = at('2026-03-01T00:00:00Z');
const FEB_28 = at('2026-02-28T00:00:00Z');
const FEB_1 = at('2026-02-01T00:00:00Z');

type GraphAnswer = Pick<PriceGraphConversion, 'rate' | 'effectiveAt' | 'path'>;

/** What the live resolver answers, by token id; a token it cannot price is absent. */
const live = new Map<string, string>();
const liveCalls: Array<{ tokenIds: string[]; baseSymbol: string; at: Date }> = [];
/** What the price graph answers, by token id; a token it cannot route is absent. */
const graphed = new Map<string, GraphAnswer>();
const convertCalls: Array<{ from: string; to: string; at: Date }> = [];
/** The granularity each conversion preferred at a tie, in call order. */
const preferences: Array<{ from: string; at: Date; prefer: string | undefined }> = [];
let beforeConvert: ((to: string, options: PriceGraphOptions) => Promise<void>) | null = null;
/** When set, the graph converts from the stored rows instead of answering from `graphed`. */
let realGraph = false;

Container.set(PricingService, {
  getCachedTokenPrices: async (tokens: Token[], base: Token, timestamp: Date) => {
    liveCalls.push({
      tokenIds: tokens.map((t) => t.id).sort(),
      baseSymbol: base.symbol,
      at: timestamp,
    });
    const prices = new Map<string, string>();
    for (const token of tokens) {
      const price = live.get(token.id);
      if (price !== undefined) prices.set(token.id, price);
    }
    return prices;
  },
} as unknown as PricingService);

// The real graph, so `resolveHubTokenIds` and `buildPriceLookup` read the
// seeded hubs and rows; only the conversion itself is scripted.
const graph = new PriceGraphService();
const storedConvert = graph.convert.bind(graph);
spyOn(graph, 'convert').mockImplementation(async (amount, from, to, when, options) => {
  convertCalls.push({ from, to, at: when });
  preferences.push({ from, at: when, prefer: options.preferGranularity });
  await beforeConvert?.(to, options);
  if (realGraph) return storedConvert(amount, from, to, when, options);
  const answer = graphed.get(from);
  if (answer === undefined) return null;
  return { ...answer, amount: new Decimal(amount).mul(answer.rate), stale: false };
});
Container.set(PriceGraphService, graph);
Container.set(PriceShadowService, new PriceShadowService());

const service = () => Container.get(PriceShadowService);

beforeEach(() => {
  live.clear();
  liveCalls.length = 0;
  graphed.clear();
  convertCalls.length = 0;
  preferences.length = 0;
  beforeConvert = null;
  realGraph = false;
});

/**
 * USD and EUR are seeded by migration; USDT is added where the database has no
 * canonical row. Looked for by identity here rather than through the resolver,
 * which warns of a hub it cannot find.
 */
async function seededHubs(tx: DatabaseTransaction) {
  const [canonicalUsdt] = await tx
    .select({ id: schema.tokens.id })
    .from(schema.tokens)
    .innerJoin(schema.tokenTypes, eq(schema.tokenTypes.id, schema.tokens.typeId))
    .where(
      and(
        eq(schema.tokens.symbol, 'USDT'),
        eq(schema.tokenTypes.code, 'crypto'),
        isNull(schema.tokens.marketSegment)
      )
    );
  if (canonicalUsdt === undefined) await makeToken(tx, { symbol: 'USDT', name: 'Tether' });
  const [usd, usdtId, eur] = await graph.resolveHubTokenIds(tx);
  if (!usd || !usdtId || !eur) throw new Error('the three hubs did not resolve');
  return { usd, usdt: usdtId, eur };
}

/** A user who holds each token through one account. */
async function holderOf(
  tx: DatabaseTransaction,
  tokenIds: readonly string[],
  baseCurrencyId: string | null
) {
  const user = await makeUser(tx, { baseCurrencyId });
  const institution = await makeInstitution(tx);
  const account = await makeAccount(tx, { userId: user.id, institutionId: institution.id });
  const holdings = [];
  for (const tokenId of tokenIds) {
    holdings.push(await makeHolding(tx, { userId: user.id, accountId: account.id, tokenId }));
  }
  return { user, holdings };
}

async function addPrice(
  tx: DatabaseTransaction,
  tokenId: string,
  baseTokenId: string,
  timestamp: Date,
  price: string,
  granularity: 'intraday' | 'daily' = 'intraday',
  source: string | null = null
): Promise<void> {
  await tx
    .insert(schema.tokenPrices)
    .values({ tokenId, baseTokenId, timestamp, price, granularity, source });
}

/** A holding of `tokenId` with `balance` units, in an account of its own. */
async function holdingOf(
  tx: DatabaseTransaction,
  userId: string,
  tokenId: string,
  balance: string,
  overrides: Partial<typeof schema.holdings.$inferInsert> = {}
) {
  const account = await makeAccount(tx, { userId, institutionId: (await makeInstitution(tx)).id });
  return makeHolding(tx, { ...overrides, userId, accountId: account.id, tokenId, balance });
}

/**
 * X priced 10 in USD this morning, which the live resolver and the graph both
 * read as 11, held 3 units by one USD user and 2 by another.
 */
async function heldAtTwoPrices(tx: DatabaseTransaction, usd: string) {
  const x = await makeToken(tx);
  await addPrice(tx, x.id, usd, MAR_1, '10');
  live.set(x.id, '11');
  graphed.set(x.id, { rate: new Decimal(11), effectiveAt: MAR_1, path: 'direct' });
  const first = await makeUser(tx, { baseCurrencyId: usd });
  const second = await makeUser(tx, { baseCurrencyId: usd });
  await holdingOf(tx, first.id, x.id, '3');
  await holdingOf(tx, second.id, x.id, '2');
  return { x, first, second };
}

/**
 * The SC-1477 shape for an EUR-base user holding X: a month-old X/EUR row at
 * 9, and an X/USD row at 10 with EUR/USD at 1.25 from this morning, which make
 * 8 through the USD hub.
 */
async function sc1477(tx: DatabaseTransaction, hubs: { usd: string; eur: string }) {
  const x = await makeToken(tx);
  await addPrice(tx, x.id, hubs.eur, FEB_1, '9');
  await addPrice(tx, x.id, hubs.usd, MAR_1, '10');
  await addPrice(tx, hubs.eur, hubs.usd, MAR_1, '1.25');
  live.set(x.id, '9');
  graphed.set(x.id, { rate: new Decimal(9), effectiveAt: FEB_1, path: 'direct' });
  return x;
}

describe('PriceShadowService.run', () => {
  test("SC-1477 shape: the live resolver's older EUR row is reported as fresher-price", async () => {
    await withTestDb(async (tx) => {
      const hubs = await seededHubs(tx);
      const x = await sc1477(tx, hubs);
      const { user } = await holderOf(tx, [x.id], hubs.eur);

      const { runId, summary } = await service().run({ asOf: AS_OF, userId: user.id }, tx);

      const rows = await differencesOf(tx, runId);
      expect(rows.map((r) => r.comparator).sort()).toEqual(['live-resolver', 'price-graph']);
      for (const row of rows) {
        expect(row).toMatchObject({
          userId: null,
          holdingId: null,
          tokenId: x.id,
          baseTokenId: hubs.eur,
          at: AS_OF,
          category: 'fresher-price',
          engineValue: '8',
          legacyValue: '9',
          detail: { enginePath: `hub:${hubs.usd}`, engineReadingAt: MAR_1.toISOString() },
        });
      }
      expect(summary).toMatchObject({
        compared: 2,
        matched: 0,
        byCategory: { 'fresher-price': 2 },
      });
      expect(liveCalls).toEqual([{ tokenIds: [x.id], baseSymbol: 'EUR', at: AS_OF }]);
      expect(convertCalls).toEqual([{ from: x.id, to: hubs.eur, at: AS_OF }]);
    });
  });

  test('a user with no base currency is priced in USD', async () => {
    await withTestDb(async (tx) => {
      const hubs = await seededHubs(tx);
      const x = await makeToken(tx);
      const { user } = await holderOf(tx, [x.id], null);
      await addPrice(tx, x.id, hubs.usd, MAR_1, '10');
      live.set(x.id, '10');

      const { runId, summary } = await service().run({ asOf: AS_OF, userId: user.id }, tx);

      expect(liveCalls.map((c) => c.baseSymbol)).toEqual(['USD']);
      expect(convertCalls.map((c) => c.to)).toEqual([hubs.usd]);
      // The graph is scripted to route nothing, so its comparison is the one
      // that differs, and its row names the base.
      const rows = await differencesOf(tx, runId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        comparator: 'price-graph',
        category: 'legacy-unpriced',
        tokenId: x.id,
        baseTokenId: hubs.usd,
        engineValue: '10',
        legacyValue: null,
      });
      expect(summary).toMatchObject({ compared: 2, matched: 1 });
    });
  });

  test('a token nothing prices on the engine side but the live resolver prices is engine-unpriced', async () => {
    await withTestDb(async (tx) => {
      const hubs = await seededHubs(tx);
      const y = await makeToken(tx);
      const { user } = await holderOf(tx, [y.id], hubs.eur);
      live.set(y.id, '5');

      const { runId, summary } = await service().run({ asOf: AS_OF, userId: user.id }, tx);

      const rows = await differencesOf(tx, runId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        comparator: 'live-resolver',
        category: 'engine-unpriced',
        tokenId: y.id,
        baseTokenId: hubs.eur,
        engineValue: null,
        legacyValue: '5',
      });
      // Unpriced by the engine and by the graph alike: that one matches.
      expect(summary).toMatchObject({
        compared: 2,
        matched: 1,
        byCategory: { 'engine-unpriced': 1 },
      });
    });
  });

  test('a token quoted in a third currency is as fresh as the live resolver reads it, and priced without it', async () => {
    await withTestDb(async (tx) => {
      const hubs = await seededHubs(tx);
      const x = await makeToken(tx);
      // Neither the base nor a hub, so no route the engine takes passes through it.
      const third = await makeToken(tx);
      const { user } = await holderOf(tx, [x.id], hubs.eur);
      await addPrice(tx, x.id, hubs.usd, FEB_28, '10');
      await addPrice(tx, hubs.eur, hubs.usd, FEB_28, '1.25');
      await addPrice(tx, x.id, third.id, MAR_1, '1000');
      live.set(x.id, '9');

      const { runId } = await service().run({ asOf: AS_OF, userId: user.id }, tx);

      const rows = await differencesOf(tx, runId);
      const liveRow = rows.find((r) => r.comparator === 'live-resolver');
      // Read only through the routed pairs, X's newest row is Feb 28, outside
      // the live window, and the difference would read as `stale-fallback`.
      expect(liveRow).toMatchObject({
        category: 'fx-leg',
        engineValue: '8',
        detail: {
          enginePath: `hub:${hubs.usd}`,
          newestReadingAt: MAR_1.toISOString(),
          directReadingAt: null,
        },
      });
    });
  });

  test('matches are counted, not stored', async () => {
    await withTestDb(async (tx) => {
      const hubs = await seededHubs(tx);
      const x = await makeToken(tx);
      // The base itself is held too: identity on every side.
      const { user } = await holderOf(tx, [x.id, hubs.eur], hubs.eur);
      await addPrice(tx, x.id, hubs.eur, MAR_1, '9');
      live.set(x.id, '9');
      live.set(hubs.eur, '1');
      graphed.set(x.id, { rate: new Decimal('9.0000000001'), effectiveAt: MAR_1, path: 'direct' });
      graphed.set(hubs.eur, { rate: new Decimal(1), effectiveAt: AS_OF, path: 'identity' });

      const { runId, summary } = await service().run({ asOf: AS_OF, userId: user.id }, tx);

      expect(summary).toMatchObject({ compared: 4, matched: 4, byCategory: {} });
      expect(summary).not.toHaveProperty('unlabelled');
      expect(await differencesOf(tx, runId)).toEqual([]);
    });
  });

  test('users who share a base are priced together: each held token once, its readings loaded once for now and every past close', async () => {
    await withTestDb(async (tx) => {
      const hubs = await seededHubs(tx);
      const x = await makeToken(tx);
      const y = await makeToken(tx);
      const first = await holderOf(tx, [x.id, y.id], hubs.eur);
      const second = await holderOf(tx, [x.id], hubs.eur);
      const closes = [at('2026-02-27T23:59:59.999Z'), at('2026-02-20T23:59:59.999Z')];
      for (const [token, price] of [
        [x, '9'],
        [y, '2'],
      ] as const) {
        for (const when of [MAR_1, ...closes]) await addPrice(tx, token.id, hubs.eur, when, price);
        live.set(token.id, price);
        graphed.set(token.id, { rate: new Decimal(price), effectiveAt: MAR_1, path: 'direct' });
      }
      const users = onlyUsers([first.user, second.user]);
      const loads = spyOn(Container.get(EngineEvidenceRepository), 'findPriceReadingsAtInstants');

      let result: Awaited<ReturnType<PriceShadowService['run']>>;
      let loaded: number;
      try {
        result = await service().run({ asOf: AS_OF, pastInstants: closes }, tx);
      } finally {
        // Read before `mockRestore`, which clears the calls it recorded.
        loaded = loads.mock.calls.length;
        users.mockRestore();
        loads.mockRestore();
      }

      // Two tokens against both resolvers at now, and against the daily graph at each close.
      expect(result.summary).toMatchObject({ compared: 8, matched: 8 });
      expect(loaded).toBe(1);
      expect(liveCalls).toEqual([{ tokenIds: [x.id, y.id].sort(), baseSymbol: 'EUR', at: AS_OF }]);
    });
  });

  test('a run prices the tokens of the holdings the shared inclusion rule counts, and no others', async () => {
    await withTestDb(async (tx) => {
      const hubs = await seededHubs(tx);
      const counted = await makeToken(tx);
      const sweepHidden = await makeToken(tx);
      const ownerHidden = await makeToken(tx);
      const { user, holdings } = await holderOf(
        tx,
        [counted.id, sweepHidden.id, ownerHidden.id],
        hubs.eur
      );
      const [, sweepHolding, ownerHolding] = holdings;
      await tx
        .update(schema.holdings)
        .set({ isHidden: true, hiddenBy: 'auto' })
        .where(sql`${schema.holdings.id} = ${sweepHolding?.id}`);
      await tx
        .update(schema.holdings)
        .set({ isHidden: true, hiddenBy: 'user' })
        .where(sql`${schema.holdings.id} = ${ownerHolding?.id}`);

      await service().run({ asOf: AS_OF, userId: user.id }, tx);

      expect(liveCalls).toEqual([
        { tokenIds: [counted.id, sweepHidden.id].sort(), baseSymbol: 'EUR', at: AS_OF },
      ]);
    });
  });

  test('REVIEW FOCUS 4: a run writes only its report', async () => {
    await withTestDb(async (tx) => {
      const hubs = await seededHubs(tx);
      const x = await sc1477(tx, hubs);
      const { user, holdings } = await holderOf(tx, [x.id], hubs.eur);
      const holding = holdings[0];
      if (!holding) throw new Error('no holding');
      await tx.insert(schema.holdingBalanceObservations).values({
        userId: user.id,
        holdingId: holding.id,
        balance: '100',
        observedAt: FEB_1,
        source: 'sync-capture',
        sourceMetadata: { origin: 'updateHolding' },
      });
      await makeHoldingTransaction(tx, {
        userId: user.id,
        holdingId: holding.id,
        tokenId: x.id,
        kind: 'deposit',
        quantity: '5',
        source: 'etherscan',
        occurredAt: MAR_1,
      });
      // `token_prices` is fingerprinted too. In production the live resolver
      // may write the FX rates it fetches there, the one write Review Focus 4
      // tolerates; it is stubbed here, so nothing at all may change.
      const before = await evidenceFingerprint(tx);

      const { runId } = await service().run({ asOf: AS_OF }, tx);

      expect(await evidenceFingerprint(tx)).toEqual(before);
      expect(before.guard).toBe('D');
      // Not vacuous: the run did compare, and stored what it found.
      expect((await differencesOf(tx, runId)).length).toBeGreaterThanOrEqual(2);
    });
  });

  test('a run says whether it covered one user or all, and is timed on the wall clock', async () => {
    await withTestDb(async (tx) => {
      const hubs = await seededHubs(tx);
      const x = await makeToken(tx);
      const z = await makeToken(tx);
      const { user } = await holderOf(tx, [x.id], hubs.eur);
      await holderOf(tx, [z.id], hubs.eur);
      const wallBefore = Date.now();

      const narrowed = await service().run({ asOf: AS_OF, userId: user.id }, tx);
      const narrowedPriced = liveCalls.map((c) => c.tokenIds);
      const full = await service().run({ asOf: AS_OF }, tx);

      // The narrowed run priced the narrowed user's token alone.
      expect(narrowedPriced).toEqual([[x.id]]);
      expect(narrowed.summary.compared).toBe(2);
      const one = await runRow(tx, narrowed.runId);
      const all = await runRow(tx, full.runId);
      expect(one).toMatchObject({ kind: 'price', scope: 'user', status: 'complete', error: null });
      expect(all).toMatchObject({ kind: 'price', scope: 'all', status: 'complete', error: null });
      for (const run of [one, all]) {
        expect(run.asOf.getTime()).toBe(AS_OF.getTime());
        expect(run.startedAt.getTime()).toBeGreaterThanOrEqual(wallBefore);
        expect(run.finishedAt.getTime()).toBeGreaterThanOrEqual(run.startedAt.getTime());
        expect(run.summary.durationMs).toBe(run.finishedAt.getTime() - run.startedAt.getTime());
      }
    });
  });

  test('a setup that throws fails the run, which is recorded, and the error propagates', async () => {
    await withTestDb(async (tx) => {
      const user = await makeUser(tx);
      const users = failingShadowUsers();
      const recorded = captureRunIds();

      let thrown: unknown;
      try {
        await service().run({ asOf: AS_OF, userId: user.id }, tx);
      } catch (err) {
        thrown = err;
      } finally {
        users.mockRestore();
        recorded.restore();
      }

      expect(thrown).toBeInstanceOf(Error);
      expect(recorded.ids).toHaveLength(1);
      const run = await runRow(tx, recorded.ids[0] ?? '');
      expect(run).toMatchObject({ kind: 'price', scope: 'user', status: 'failed' });
      expect(run.error).toMatch(/^setup: .*division by zero/);
      expect(run.summary).toMatchObject({ compared: 0, matched: 0, byCategory: {} });
      expect(convertCalls).toEqual([]);
    });
  });

  test('a base that throws fails the run, which is recorded, and the error propagates', async () => {
    await withTestDb(async (tx) => {
      const hubs = await seededHubs(tx);
      const x = await makeToken(tx);
      const z = await makeToken(tx);
      const inEur = await holderOf(tx, [x.id], hubs.eur);
      const inUsd = await holderOf(tx, [z.id], null);
      for (const [token, base] of [
        [x, hubs.eur],
        [z, hubs.usd],
      ] as const) {
        await addPrice(tx, token.id, base, MAR_1, '3');
        live.set(token.id, '3');
        graphed.set(token.id, { rate: new Decimal(3), effectiveAt: MAR_1, path: 'direct' });
      }
      const users = onlyUsers([inEur.user, inUsd.user]);
      // A database error, so it aborts whatever transaction it runs in: the
      // failed run can only be stored outside the base's savepoint.
      beforeConvert = async (to, options) => {
        if (to !== convertCalls[0]?.to) await options.tx?.execute(sql`SELECT 1/0`);
      };
      const recorded = captureRunIds();

      let thrown: unknown;
      try {
        await service().run({ asOf: AS_OF }, tx);
      } catch (err) {
        thrown = err;
      } finally {
        users.mockRestore();
        recorded.restore();
      }

      expect(thrown).toBeInstanceOf(Error);
      expect(recorded.ids).toHaveLength(1);
      const run = await runRow(tx, recorded.ids[0] ?? '');
      const failedBase = convertCalls.at(-1)?.to;
      expect(failedBase).toBeDefined();
      expect(failedBase).not.toBe(convertCalls[0]?.to);
      expect(run).toMatchObject({ kind: 'price', scope: 'all', status: 'failed' });
      expect(run.error).toContain(`base ${failedBase}`);
      expect(run.error).toContain('division by zero');
      // The first base finished before the second failed, and is in the report.
      expect(run.summary).toMatchObject({ compared: 2, matched: 2 });
    });
  });
});

describe('the past days, the daily mode and the value at stake', () => {
  test('a past day close is compared against the daily-preferring graph', async () => {
    await withTestDb(async (tx) => {
      const hubs = await seededHubs(tx);
      const x = await makeToken(tx);
      const user = await makeUser(tx, { baseCurrencyId: hubs.usd });
      await holdingOf(tx, user.id, x.id, '1');
      const CLOSE = at('2026-02-27T23:59:59.999Z');
      // A daily and an intraday row at the close: the engine ranks the intraday
      // one first, the graph asked for daily takes the daily one.
      await addPrice(tx, x.id, hubs.usd, CLOSE, '10', 'daily');
      await addPrice(tx, x.id, hubs.usd, CLOSE, '11');
      await addPrice(tx, x.id, hubs.usd, MAR_1, '12');
      live.set(x.id, '12');
      realGraph = true;

      const { runId, summary } = await service().run(
        { asOf: AS_OF, pastInstants: [CLOSE], userId: user.id },
        tx
      );

      const rows = await differencesOf(tx, runId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        comparator: 'price-graph-daily',
        category: 'same-instant-granularity',
        at: CLOSE,
        engineValue: '11',
        legacyValue: '10',
        tokenId: x.id,
        baseTokenId: hubs.usd,
        detail: {
          enginePath: 'direct',
          engineReadingAt: CLOSE.toISOString(),
          legacyPath: 'direct',
          legacyReadingAt: CLOSE.toISOString(),
        },
      });
      // The value at stake is a difference at now's alone.
      expect(rows[0]?.detail).not.toHaveProperty('valueImpact');
      // The live resolver answers only for now.
      expect(liveCalls).toEqual([{ tokenIds: [x.id], baseSymbol: 'USD', at: AS_OF }]);
      expect(preferences).toEqual([
        { from: x.id, at: AS_OF, prefer: undefined },
        { from: x.id, at: CLOSE, prefer: 'daily' },
        // Asked again with the tie going to the intraday row, which agrees.
        { from: x.id, at: CLOSE, prefer: 'intraday' },
      ]);
      expect(summary).toMatchObject({
        compared: 3,
        matched: 2,
        byCategory: { 'same-instant-granularity': 1 },
        byInstant: {
          [AS_OF.toISOString()]: {},
          [CLOSE.toISOString()]: { 'same-instant-granularity': 1 },
        },
        valueImpactByBase: {},
      });
    });
  });

  test('a difference at now carries the value at stake', async () => {
    await withTestDb(async (tx) => {
      const hubs = await seededHubs(tx);
      const { x, first, second } = await heldAtTwoPrices(tx, hubs.usd);
      const users = onlyUsers([first, second]);

      let result: Awaited<ReturnType<PriceShadowService['run']>>;
      try {
        result = await service().run({ asOf: AS_OF }, tx);
      } finally {
        users.mockRestore();
      }

      const rows = await differencesOf(tx, result.runId);
      expect(rows.map((r) => r.comparator).sort()).toEqual(['live-resolver', 'price-graph']);
      for (const row of rows) {
        expect(row).toMatchObject({
          userId: null,
          tokenId: x.id,
          baseTokenId: hubs.usd,
          engineValue: '10',
          legacyValue: '11',
          detail: { valueImpact: '-5', holders: 2 },
        });
      }
      expect(result.summary.valueImpactByBase).toEqual({
        [hubs.usd]: { 'live-resolver': '-5', 'price-graph': '-5' },
      });
    });
  });

  test('CONTROL: an owner-hidden holding adds nothing to the value at stake', async () => {
    await withTestDb(async (tx) => {
      const hubs = await seededHubs(tx);
      const { x, first, second } = await heldAtTwoPrices(tx, hubs.usd);
      await holdingOf(tx, first.id, x.id, '100', { isHidden: true, hiddenBy: 'user' });
      await holdingOf(tx, second.id, x.id, '50', { isActive: false });
      // The other half of the rule, so the control can fail: a holding the
      // closed-position sweep hid still counts.
      await holdingOf(tx, second.id, x.id, '1', { isHidden: true, hiddenBy: 'auto' });
      const users = onlyUsers([first, second]);

      let result: Awaited<ReturnType<PriceShadowService['run']>>;
      try {
        result = await service().run({ asOf: AS_OF }, tx);
      } finally {
        users.mockRestore();
      }

      const rows = await differencesOf(tx, result.runId);
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.detail).toMatchObject({ valueImpact: '-6', holders: 3 });
      }
    });
  });
});

describe("a person's price one side answers from alone", () => {
  test('a price typed again in a quote currency: the graph still reads the superseded one, unexplained', async () => {
    await withTestDb(async (tx) => {
      const hubs = await seededHubs(tx);
      const x = await makeToken(tx);
      const chf = await makeToken(tx);
      const { user } = await holderOf(tx, [x.id], hubs.usd);
      await addPrice(tx, x.id, hubs.usd, FEB_1, '10', 'intraday', 'manual');
      await addPrice(tx, x.id, chf.id, FEB_28, '20', 'intraday', 'manual');
      await addPrice(tx, chf.id, hubs.usd, MAR_1, '1.1');
      live.set(x.id, '22');
      realGraph = true;

      const { runId } = await service().run({ asOf: AS_OF, userId: user.id }, tx);

      const rows = await differencesOf(tx, runId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        comparator: 'price-graph',
        category: 'unexplained',
        engineValue: '22',
        legacyValue: '10',
        detail: {
          enginePath: `quote:${chf.id}`,
          engineReadingAt: FEB_28.toISOString(),
          engineTypedIn: chf.id,
          legacyPath: 'direct',
          legacyReadingAt: FEB_1.toISOString(),
          legacyTypedIn: hubs.usd,
        },
      });
    });
  });

  test('a provider reading in a quote currency newer than a typed price: unexplained on both comparators', async () => {
    await withTestDb(async (tx) => {
      const hubs = await seededHubs(tx);
      const x = await makeToken(tx);
      const chf = await makeToken(tx);
      const { user } = await holderOf(tx, [x.id], hubs.usd);
      await addPrice(tx, x.id, hubs.usd, FEB_1, '10', 'intraday', 'manual');
      await addPrice(tx, x.id, chf.id, MAR_1, '20', 'intraday', 'kraken');
      await addPrice(tx, chf.id, hubs.usd, MAR_1, '1.1');
      // The live resolver serves the typed row in the base, whatever its age.
      live.set(x.id, '10');
      realGraph = true;

      const { runId } = await service().run({ asOf: AS_OF, userId: user.id }, tx);

      const rows = await differencesOf(tx, runId);
      expect(rows.map((r) => r.comparator).sort()).toEqual(['live-resolver', 'price-graph']);
      for (const row of rows) {
        expect(row).toMatchObject({
          category: 'unexplained',
          engineValue: '22',
          legacyValue: '10',
          detail: { enginePath: `quote:${chf.id}`, engineTypedIn: null, legacyTypedIn: hubs.usd },
        });
      }
    });
  });
});

describe('PriceShadowService.compareAt', () => {
  test('compareAt answers for an instant the nightly run does not sample', async () => {
    await withTestDb(async (tx) => {
      const hubs = await seededHubs(tx);
      const x = await makeToken(tx);
      const y = await makeToken(tx);
      const NINE = at('2026-02-15T09:00:00Z');
      const NOON = at('2026-02-15T12:00:00Z');
      await addPrice(tx, x.id, hubs.usd, NINE, '10');
      await addPrice(tx, x.id, hubs.usd, at('2026-02-15T15:00:00Z'), '12');
      await addPrice(tx, y.id, hubs.usd, NINE, '5');
      graphed.set(x.id, { rate: new Decimal(9), effectiveAt: FEB_1, path: 'direct' });
      graphed.set(y.id, { rate: new Decimal(5), effectiveAt: NINE, path: 'direct' });

      const differences = await service().compareAt(
        [
          { tokenId: x.id, at: NOON },
          { tokenId: y.id, at: NOON },
        ],
        hubs.usd,
        tx
      );

      expect(differences).toHaveLength(1);
      expect(differences[0]).toMatchObject({
        comparator: 'price-graph-daily',
        category: 'fresher-price',
        at: NOON,
        engineValue: '10',
        legacyValue: '9',
        tokenId: x.id,
        baseTokenId: hubs.usd,
        detail: { engineReadingAt: NINE.toISOString() },
      });
      expect(differences[0]?.detail).not.toHaveProperty('valueImpact');
      expect(preferences).toEqual([
        { from: x.id, at: NOON, prefer: 'daily' },
        { from: y.id, at: NOON, prefer: 'daily' },
      ]);
      expect(liveCalls).toEqual([]);
    });
  });
});

describe('the same-instant re-ask', () => {
  test('a quote route read at the same instant is quote-route, and the graph is asked once', async () => {
    await withTestDb(async (tx) => {
      const hubs = await seededHubs(tx);
      const x = await makeToken(tx);
      const quote = await makeToken(tx);
      const { user } = await holderOf(tx, [x.id], hubs.usd);
      await addPrice(tx, x.id, quote.id, MAR_1, '100');
      await addPrice(tx, quote.id, hubs.usd, MAR_1, '1.1');
      live.set(x.id, '110');
      graphed.set(x.id, { rate: new Decimal(100), effectiveAt: MAR_1, path: 'direct' });

      const { runId } = await service().run({ asOf: AS_OF, userId: user.id }, tx);

      const rows = await differencesOf(tx, runId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        comparator: 'price-graph',
        category: 'quote-route',
        detail: {
          enginePath: `quote:${quote.id}`,
          engineReadingAt: MAR_1.toISOString(),
          legacyReadingAt: MAR_1.toISOString(),
        },
      });
      // `quote-route` is decided before a tie's granularity could be.
      expect(convertCalls).toEqual([{ from: x.id, to: hubs.usd, at: AS_OF }]);
    });
  });
});
