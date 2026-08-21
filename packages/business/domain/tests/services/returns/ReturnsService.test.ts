process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { beforeEach, describe, expect, test } from 'bun:test';
import Decimal from 'decimal.js';
import { Container } from 'typedi';
import { GroupRepository } from '../../../src/repositories/GroupRepository';
import { HoldingRepository } from '../../../src/repositories/HoldingRepository';
import { HoldingTransactionRepository } from '../../../src/repositories/HoldingTransactionRepository';
import { PortfolioValueDailyRepository } from '../../../src/repositories/PortfolioValueDailyRepository';
import { TokenRepository } from '../../../src/repositories/TokenRepository';
import { UserRepository } from '../../../src/repositories/UserRepository';
import { VaultRepository } from '../../../src/repositories/VaultRepository';
import { PriceGraphService } from '../../../src/services/pricing/PriceGraphService';
import { AssetCurrencyService } from '../../../src/services/returns/AssetCurrencyService';
import { ExternalFlowService } from '../../../src/services/returns/ExternalFlowService';
import { ReturnsScopeResolver } from '../../../src/services/returns/ReturnsScopeResolver';
import {
  type ReturnsOutcome,
  type ReturnsRequest,
  type ReturnsResult,
  ReturnsService,
} from '../../../src/services/returns/ReturnsService';
import { restoreContainerAfterAll } from '../../../test/helpers/container';

// Container stubs are process-global; put back whatever this file changes so
// no later test file resolves them (SC-448).
restoreContainerAfterAll();

const USER = 'user-1';
const BASE = 'token-usd';
const NOW = new Date('2026-03-10T12:00:00.000Z');

/**
 * Every `base_currency_id` the repository was asked for, in call order.
 *
 * The assertion this exists for is the one the original suite could not make
 * (SC-457 review): a stub that ignores the parameter cannot tell a resolved
 * currency from `undefined`, and `undefined` is what shipped. The stub below
 * now FILTERS on it as the real SQL does, so a wrong currency returns nothing,
 * and records it so a test can name the value directly.
 */
const baseCurrencyCalls: Array<string | undefined> = [];

/** Token id sets handed to `buildPriceLookup`, one entry per prefetch. */
const priceLookupBuilds: string[][] = [];

/** Every `PriceGraphService.convert`, and whether it was given the prefetch. */
const convertCalls: Array<{ fromTokenId: string; toTokenId: string; withLookup: boolean }> = [];

interface DayRow {
  date: string;
  holdingId: string;
  value: string;
  /** Defaults to 1 — the day was priced. 0 means nothing could be priced. */
  known?: number;
  quality?: string;
}

interface TxRow {
  id: string;
  holdingId: string;
  kind: string;
  quantity: string;
  occurredAt: string;
  /** Per-unit price already denominated in the base currency. */
  priceNative?: string | null;
  tokenId?: string;
}

interface Fixture {
  holdings: Array<{ id: string; tokenId: string; accountId: string }>;
  /**
   * The `tokens` rows behind those holdings, for SC-458's currency
   * resolution. ABSENT BY DEFAULT, and that is load-bearing: with no token
   * rows nothing can be placed in a currency, so no FX prefetch happens and
   * no rate conversion is issued — which is what keeps every SC-457 and
   * SC-471 scenario in this file at exactly the query and conversion counts
   * they were written to assert.
   */
  tokens?: Array<{ id: string; symbol: string; typeCode: string; marketSegment?: string | null }>;
  /** The fiat `tokens` rows a resolved currency symbol maps onto. */
  fiatTokens?: Array<{ id: string; symbol: string }>;
  /**
   * `currency token id -> base rate`, either flat or per `YYYY-MM-DD`. Read
   * by the `convert` stub when the FX attribution asks for a rate, which is a
   * different question from `rates` below — that one values a FLOW from the
   * token it moved.
   */
  fxRates?: Record<string, string | Record<string, string | null>>;
  /** `users.base_currency_id`. `null` = the account never set one. */
  userBaseCurrencyId?: string | null;
  days: DayRow[];
  txs: TxRow[];
  /** token -> base rate, for the held-token valuation path. */
  rates?: Record<string, string>;
  groupHoldings?: Record<string, string[]>;
  vaults?: Record<string, Array<{ holdingId: string; percentage: number }>>;
}

function install(fixture: Fixture): ReturnsService {
  const holdingById = new Map(fixture.holdings.map((h) => [h.id, h]));

  Container.set(PortfolioValueDailyRepository, {
    findIncludedHoldingScopeRange: async (
      _userId: string,
      baseCurrencyId: string,
      from: Date,
      to: Date,
      _tx?: unknown,
      holdingIds?: readonly string[]
    ) => {
      baseCurrencyCalls.push(baseCurrencyId);
      // `base_currency_id` is part of this table's primary key, so the real
      // query returns NOTHING for a currency the rollup never wrote — and
      // postgres.js refuses the statement outright for `undefined`. Both are
      // modelled: asking with the wrong currency yields an empty series here
      // too, so a test cannot pass by ignoring the parameter.
      if (baseCurrencyId === undefined || baseCurrencyId === null) {
        throw new Error('UNDEFINED_VALUE: base_currency_id was undefined');
      }
      if (baseCurrencyId !== (fixture.userBaseCurrencyId ?? BASE)) return [];
      const fromStr = from.toISOString().slice(0, 10);
      const toStr = to.toISOString().slice(0, 10);
      const wanted = holdingIds ? new Set(holdingIds) : null;
      return fixture.days
        .filter((d) => d.date >= fromStr && d.date <= toStr)
        .filter((d) => !wanted || wanted.has(d.holdingId))
        .map((d) => ({
          snapshotDate: d.date,
          holdingId: d.holdingId,
          totalValue: d.value,
          costBasis: null,
          realizedPnl: null,
          unrealizedPnl: null,
          coverageQuality: d.quality ?? 'full',
          holdingsWithKnownValue: d.known ?? 1,
          holdingsTotal: 1,
          holdingsUnpriceable: 0,
          holdingsStalePriced: 0,
          holdingsBasisUnknown: 0,
          transfersUnreviewed: 0,
        }));
    },
  } as never);

  Container.set(UserRepository, {
    findById: async (id: string) =>
      id === USER
        ? {
            id: USER,
            baseCurrencyId:
              fixture.userBaseCurrencyId === undefined ? BASE : fixture.userBaseCurrencyId,
          }
        : null,
  } as never);

  Container.set(HoldingRepository, {
    findIdsForUser: async (_userId: string, filter?: { accountId?: string }) =>
      fixture.holdings
        .filter((h) => !filter?.accountId || h.accountId === filter.accountId)
        .map((h) => h.id),
    findByIds: async (ids: string[]) => ids.map((id) => holdingById.get(id)).filter(Boolean),
  } as never);

  Container.set(HoldingTransactionRepository, {
    findForHoldingsInRange: async (holdingIds: readonly string[], from: Date, to: Date) => {
      const wanted = new Set(holdingIds);
      return fixture.txs
        .filter((t) => wanted.has(t.holdingId))
        .map((t) => ({
          id: t.id,
          holdingId: t.holdingId,
          kind: t.kind,
          quantity: t.quantity,
          occurredAt: new Date(t.occurredAt),
          priceNative: t.priceNative ?? null,
          priceNativeTokenId: t.priceNative ? BASE : null,
          tokenId: t.tokenId ?? holdingById.get(t.holdingId)?.tokenId ?? 'token-x',
        }))
        .filter((t) => t.occurredAt > from && t.occurredAt <= to)
        .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
    },
  } as never);

  // The prefetch, recorded rather than mocked away: SC-471 is a ticket about
  // how MANY times the price graph is consulted, so the count and the tokens
  // it was asked to cover are what a test has to be able to see.
  Container.set(PriceGraphService, {
    buildPriceLookup: async (tokenIds: Iterable<string>) => {
      priceLookupBuilds.push([...tokenIds].sort());
      return { covers: () => true } as never;
    },
    convert: async (
      amount: Decimal,
      fromTokenId: string,
      toTokenId: string,
      _at: Date,
      options?: { priceLookup?: unknown }
    ) => {
      convertCalls.push({ fromTokenId, toTokenId, withLookup: options?.priceLookup !== undefined });
      if (fromTokenId === toTokenId) {
        return { amount, rate: new Decimal(1), effectiveAt: NOW, path: 'identity', stale: false };
      }
      const fx = fixture.fxRates?.[fromTokenId];
      if (fx !== undefined) {
        const resolved = typeof fx === 'string' ? fx : (fx[_at.toISOString().slice(0, 10)] ?? null);
        if (resolved === null) return null;
        return {
          amount: new Decimal(amount).mul(resolved),
          rate: new Decimal(resolved),
          effectiveAt: _at,
          path: 'direct',
          stale: false,
        };
      }
      const rate = fixture.rates?.[fromTokenId];
      if (!rate) return null;
      return {
        amount: new Decimal(amount).mul(rate),
        rate: new Decimal(rate),
        effectiveAt: NOW,
        path: 'direct',
        stale: false,
      };
    },
  } as never);

  Container.set(GroupRepository, {
    findById: async (id: string) => (fixture.groupHoldings?.[id] ? { id, userId: USER } : null),
    findHoldingIdsByGroupIds: async (_userId: string, groupIds: string[]) =>
      groupIds.flatMap((groupId) =>
        (fixture.groupHoldings?.[groupId] ?? []).map((holdingId) => ({ groupId, holdingId }))
      ),
  } as never);

  Container.set(VaultRepository, {
    findById: async (id: string) => (fixture.vaults?.[id] ? { id, userId: USER } : null),
    findVaultHoldings: async (vaultId: string) =>
      (fixture.vaults?.[vaultId] ?? []).map((entry) => ({
        vaultHolding: { percentage: entry.percentage },
        holding: holdingById.get(entry.holdingId),
      })),
  } as never);

  Container.set(TokenRepository, {
    findManyWithTypes: async (ids: string[]) => {
      const wanted = new Set(ids);
      return (fixture.tokens ?? [])
        .filter((token) => wanted.has(token.id))
        .map((token) => ({
          id: token.id,
          symbol: token.symbol,
          typeCode: token.typeCode,
          marketSegment: token.marketSegment ?? null,
        }));
    },
    findByType: async (typeCode: string) =>
      typeCode === 'fiat'
        ? (fixture.fiatTokens ?? []).map((token) => ({ ...token, marketSegment: null }))
        : [],
  } as never);

  Container.set(AssetCurrencyService, new AssetCurrencyService());

  const resolver = new ReturnsScopeResolver();
  Container.set(ReturnsScopeResolver, resolver);
  const flowService = new ExternalFlowService();
  Container.set(ExternalFlowService, flowService);
  const service = new ReturnsService();
  Container.set(ReturnsService, service);
  return service;
}

function request(overrides: Partial<ReturnsRequest> = {}): ReturnsRequest {
  return {
    userId: USER,
    scope: { kind: 'user' },
    window: { kind: 'all' },
    now: NOW,
    ...overrides,
  };
}

/** Unwrap a successful outcome, failing loudly on any other status. */
function ok(outcome: ReturnsOutcome): ReturnsResult {
  if (outcome.status !== 'ok') throw new Error(`expected ok, got ${outcome.status}`);
  return outcome.returns;
}

const ONE_HOLDING = [{ id: 'h1', tokenId: 'token-btc', accountId: 'acc-1' }];

function days(holdingId: string, values: Array<[string, string]>): DayRow[] {
  return values.map(([date, value]) => ({ date, holdingId, value }));
}

beforeEach(() => {
  Container.remove(ReturnsService);
  Container.remove(AssetCurrencyService);
  baseCurrencyCalls.length = 0;
  priceLookupBuilds.length = 0;
  convertCalls.length = 0;
});

describe('ReturnsService — the scenarios that decide whether the number is right', () => {
  test('scenario: flat portfolio, mid-window deposit — TWR is 0% where the value delta says +50%', async () => {
    const service = install({
      holdings: ONE_HOLDING,
      days: days('h1', [
        ['2026-03-01', '1000'],
        ['2026-03-02', '1000'],
        ['2026-03-03', '1500'],
        ['2026-03-04', '1500'],
      ]),
      txs: [
        {
          id: 'tx-1',
          holdingId: 'h1',
          kind: 'deposit',
          quantity: '5',
          priceNative: '100',
          occurredAt: '2026-03-03T09:00:00.000Z',
        },
      ],
    });

    const result = ok(await service.compute(request()));
    expect(result).not.toBeNull();
    expect(Number(result?.twr?.cumulative)).toBe(0);
    expect(result?.netExternalFlow).toBe('500');
    expect(result?.startValue).toBe('1000');
    expect(result?.endValue).toBe('1500');
    // The figure this replaces.
    expect(1500 / 1000 - 1).toBe(0.5);
  });

  test('scenario: mid-window withdrawal — TWR is 0% where the value delta says -40%', async () => {
    const service = install({
      holdings: ONE_HOLDING,
      days: days('h1', [
        ['2026-03-01', '1000'],
        ['2026-03-02', '600'],
        ['2026-03-03', '600'],
      ]),
      txs: [
        {
          id: 'tx-1',
          holdingId: 'h1',
          kind: 'withdraw',
          quantity: '-4',
          priceNative: '100',
          occurredAt: '2026-03-02T09:00:00.000Z',
        },
      ],
    });

    const result = ok(await service.compute(request()));
    expect(Number(result?.twr?.cumulative)).toBe(0);
    expect(result?.netExternalFlow).toBe('-400');
  });

  test('scenario: doubles then halves — TWR is 0%, and it is not silently 0 for lack of data', async () => {
    const service = install({
      holdings: ONE_HOLDING,
      days: days('h1', [
        ['2026-03-01', '100'],
        ['2026-03-02', '200'],
        ['2026-03-03', '100'],
      ]),
      txs: [],
    });

    const result = ok(await service.compute(request()));
    expect(Number(result?.twr?.cumulative)).toBe(0);
    expect(result?.twr?.measuredPeriods).toBe(2);
    expect(Number(result?.twr?.periods[0]?.return)).toBe(1);
    expect(Number(result?.twr?.periods[1]?.return)).toBe(-0.5);
    // And the money-weighted answer for a flat round trip is also flat.
    expect(result?.xirr.status === 'ok' && Math.abs(result.xirr.rate)).toBeLessThan(1e-8);
  });

  test('scenario: a deposit hides a real loss from the value delta but not from TWR', async () => {
    const service = install({
      holdings: ONE_HOLDING,
      days: days('h1', [
        ['2026-03-01', '1000'],
        ['2026-03-02', '1200'],
      ]),
      txs: [
        {
          id: 'tx-1',
          holdingId: 'h1',
          kind: 'buy',
          quantity: '4',
          priceNative: '100',
          occurredAt: '2026-03-02T09:00:00.000Z',
        },
      ],
    });

    const result = ok(await service.compute(request()));
    expect(Number(result?.twr?.cumulative)).toBeCloseTo(-0.2, 12);
    // XIRR over a ONE-DAY window is a 20% loss compounded 365 times: an
    // annual rate below anything a float64 can hold above -100%. It refuses
    // rather than printing the nearest representable number, which is the
    // whole point of the status union.
    expect(result?.xirr).toEqual({ status: 'not-converged', reason: 'no-root-in-domain' });
  });

  /**
   * A restatement is neither a gain nor a contribution (SC-510).
   *
   * A holding worth 1,000 that is recorded as 1,200 a year later because the
   * owner fixed a 200 typo. Nothing was earned and nothing was paid in.
   *
   * The two assertions pull in opposite directions on purpose, and that is
   * exactly why calling a correction "just a flow" does not work. TWR needs
   * the row SUBTRACTED from the closing value or the typo prints as a 20%
   * gain. XIRR needs it ABSENT: a cashflow there is a payment nobody made,
   * and every real flow gets discounted against it. Only a third role
   * satisfies both.
   *
   * The window is a year so both numbers are exact rather than a
   * one-day rate at the edge of what a float can hold.
   */
  test('scenario: a corrected figure is neither performance nor a contribution', async () => {
    const service = install({
      holdings: ONE_HOLDING,
      days: [
        { date: '2025-03-10', holdingId: 'h1', value: '1000' },
        { date: '2026-03-10', holdingId: 'h1', value: '1200' },
      ],
      txs: [
        {
          id: 'tx-1',
          holdingId: 'h1',
          kind: 'correction',
          quantity: '2',
          priceNative: '100',
          occurredAt: '2025-09-10T00:00:00.000Z',
        },
      ],
    });

    const result = ok(await service.compute(request()));

    // Subtracted from the close like a flow: (1200 - 200) / 1000 - 1 = 0.
    // Booked as performance instead, this reads +20%.
    expect(Number(result?.twr?.cumulative)).toBeCloseTo(0, 12);

    // And absent from the cashflows, which leaves the opening 1,000 and the
    // closing 1,200 exactly one year apart: 20%. Booked as an external flow
    // instead, XIRR would see a second 200 paid in halfway through and return
    // a materially lower rate off money nobody put in.
    if (result?.xirr.status !== 'ok') throw new Error('expected a rate');
    expect(result.xirr.rate).toBeCloseTo(0.2, 6);
  });

  test('scenario: XIRR over a year of contributions matches the NPV definition', async () => {
    const service = install({
      holdings: ONE_HOLDING,
      days: [
        { date: '2025-03-10', holdingId: 'h1', value: '1000' },
        { date: '2026-03-10', holdingId: 'h1', value: '2100' },
      ],
      txs: [
        {
          id: 'tx-1',
          holdingId: 'h1',
          kind: 'deposit',
          quantity: '10',
          priceNative: '100',
          occurredAt: '2025-09-10T00:00:00.000Z',
        },
      ],
    });

    const result = ok(await service.compute(request()));
    if (result?.xirr.status !== 'ok') throw new Error('expected a rate');
    // Re-derive the NPV from the instants themselves rather than from a
    // day count typed by hand — the assertion is the definition, not a
    // second copy of the implementation's arithmetic.
    const origin = Date.parse('2025-03-10T23:59:59.999Z');
    const years = (iso: string) => (Date.parse(iso) - origin) / (365 * 24 * 60 * 60 * 1000);
    const rate = result.xirr.rate;
    const npv =
      -1000 +
      -1000 / (1 + rate) ** years('2025-09-10T00:00:00.000Z') +
      2100 / (1 + rate) ** years('2026-03-10T23:59:59.999Z');
    expect(Math.abs(npv)).toBeLessThan(1e-6);
    expect(result.xirr.uniqueRoot).toBe(true);
    // Half the money was in for half the time, so the money-weighted rate is
    // well above the 5% the raw totals suggest.
    expect(rate).toBeGreaterThan(0.05);
  });
});

describe('ReturnsService — internal movement must not read as a contribution', () => {
  const TWO_HOLDINGS = [
    { id: 'h1', tokenId: 'token-btc', accountId: 'acc-1' },
    { id: 'h2', tokenId: 'token-eth', accountId: 'acc-2' },
  ];

  const SWAP_FIXTURE = {
    holdings: TWO_HOLDINGS,
    days: [
      { date: '2026-03-01', holdingId: 'h1', value: '1000' },
      { date: '2026-03-01', holdingId: 'h2', value: '0' },
      { date: '2026-03-02', holdingId: 'h1', value: '0' },
      { date: '2026-03-02', holdingId: 'h2', value: '1000' },
    ],
    txs: [
      {
        id: 'tx-out',
        holdingId: 'h1',
        kind: 'swap_out',
        quantity: '-10',
        priceNative: '100',
        occurredAt: '2026-03-02T09:00:00.000Z',
      },
      {
        id: 'tx-in',
        holdingId: 'h2',
        kind: 'swap_in',
        quantity: '5',
        priceNative: '200',
        occurredAt: '2026-03-02T09:00:00.000Z',
      },
    ],
  };

  test('a swap between two tracked holdings nets to zero flow — no pairing lookup needed', async () => {
    const service = install(SWAP_FIXTURE);
    const result = ok(await service.compute(request()));
    expect(result?.netExternalFlow).toBe('0');
    expect(Number(result?.twr?.cumulative)).toBe(0);
  });

  test('the SAME swap seen from one holding alone is a real outflow', async () => {
    const service = install(SWAP_FIXTURE);
    const result = ok(await service.compute(request({ scope: { kind: 'holding', id: 'h1' } })));
    // Value went 1000 -> 0, and 1000 of it left the scope. That is 0%, not -100%.
    expect(result?.netExternalFlow).toBe('-1000');
    expect(Number(result?.twr?.cumulative)).toBe(0);
  });

  test('a scoped account sees the leg that crossed its boundary', async () => {
    const service = install(SWAP_FIXTURE);
    const result = ok(await service.compute(request({ scope: { kind: 'account', id: 'acc-2' } })));
    expect(result?.netExternalFlow).toBe('1000');
    // Funded from zero: the period cannot be measured and says so.
    expect(result?.twr?.skippedPeriods).toBe(1);
    expect(result?.coverage.skippedPeriods).toBe(1);
  });
});

describe('ReturnsService — what is earned is not what is contributed', () => {
  test('a staking reward is performance, not a deposit', async () => {
    const service = install({
      holdings: ONE_HOLDING,
      days: days('h1', [
        ['2026-03-01', '1000'],
        ['2026-03-02', '1050'],
      ]),
      txs: [
        {
          id: 'tx-1',
          holdingId: 'h1',
          kind: 'reward',
          quantity: '0.5',
          priceNative: '100',
          occurredAt: '2026-03-02T09:00:00.000Z',
        },
      ],
    });

    const result = ok(await service.compute(request()));
    expect(result?.netExternalFlow).toBe('0');
    expect(Number(result?.twr?.cumulative)).toBeCloseTo(0.05, 12);
  });

  test('a fee is a cost, so it shows up as a negative return', async () => {
    const service = install({
      holdings: ONE_HOLDING,
      days: days('h1', [
        ['2026-03-01', '1000'],
        ['2026-03-02', '990'],
      ]),
      txs: [
        {
          id: 'tx-1',
          holdingId: 'h1',
          kind: 'fee',
          quantity: '-0.1',
          priceNative: '100',
          occurredAt: '2026-03-02T09:00:00.000Z',
        },
      ],
    });

    const result = ok(await service.compute(request()));
    expect(result?.netExternalFlow).toBe('0');
    expect(Number(result?.twr?.cumulative)).toBeCloseTo(-0.01, 12);
  });

  test("an opening balance is the position's funding, not a first-day miracle", async () => {
    const service = install({
      holdings: ONE_HOLDING,
      days: days('h1', [
        ['2026-03-01', '0'],
        ['2026-03-02', '1000'],
        ['2026-03-03', '1100'],
      ]),
      txs: [
        {
          id: 'tx-1',
          holdingId: 'h1',
          kind: 'opening_balance',
          quantity: '10',
          priceNative: '100',
          occurredAt: '2026-03-02T00:00:00.000Z',
        },
      ],
    });

    const result = ok(await service.compute(request()));
    expect(result?.netExternalFlow).toBe('1000');
    expect(Number(result?.twr?.cumulative)).toBeCloseTo(0.1, 12);
    expect(result?.twr?.skippedPeriods).toBe(1);
  });
});

describe('ReturnsService — windows', () => {
  const YEAR_FIXTURE = {
    holdings: ONE_HOLDING,
    days: [
      { date: '2025-12-30', holdingId: 'h1', value: '800' },
      { date: '2025-12-31', holdingId: 'h1', value: '1000' },
      { date: '2026-01-01', holdingId: 'h1', value: '1100' },
      { date: '2026-03-09', holdingId: 'h1', value: '1200' },
      { date: '2026-03-10', holdingId: 'h1', value: '1300' },
    ],
    txs: [],
  };

  test('YTD anchors on the last measured day of LAST year, so 1 January is a return', async () => {
    const service = install(YEAR_FIXTURE);
    const result = ok(await service.compute(request({ window: { kind: 'ytd' } })));
    expect(result?.effectiveWindow).toEqual({ from: '2025-12-31', to: '2026-03-10' });
    expect(result?.startValue).toBe('1000');
    expect(Number(result?.twr?.cumulative)).toBeCloseTo(0.3, 12);
  });

  test('all reaches the first measured day and reports it', async () => {
    const service = install(YEAR_FIXTURE);
    const result = ok(await service.compute(request({ window: { kind: 'all' } })));
    expect(result?.effectiveWindow).toEqual({ from: '2025-12-30', to: '2026-03-10' });
    expect(Number(result?.twr?.cumulative)).toBeCloseTo(0.625, 12);
  });

  test('a custom window measures only what it names', async () => {
    const service = install(YEAR_FIXTURE);
    const result = ok(
      await service.compute(
        request({
          window: {
            kind: 'custom',
            from: new Date('2026-01-01T00:00:00.000Z'),
            to: new Date('2026-03-09T00:00:00.000Z'),
          },
        })
      )
    );
    expect(result?.effectiveWindow).toEqual({ from: '2025-12-31', to: '2026-03-09' });
    expect(Number(result?.twr?.cumulative)).toBeCloseTo(0.2, 12);
  });

  test('a window with no measured day answers with an absence, not a zero', async () => {
    const service = install(YEAR_FIXTURE);
    const result = ok(
      await service.compute(
        request({
          window: {
            kind: 'custom',
            from: new Date('2024-01-01T00:00:00.000Z'),
            to: new Date('2024-02-01T00:00:00.000Z'),
          },
        })
      )
    );
    expect(result?.twr).toBeNull();
    expect(result?.startValue).toBeNull();
    expect(result?.xirr.status).toBe('undefined');
    expect(result?.coverage.measuredDays).toBe(0);
  });
});

describe('ReturnsService — scope, weighting and ownership', () => {
  test('a vault takes its percentage of both the value and the flows', async () => {
    const service = install({
      holdings: ONE_HOLDING,
      days: days('h1', [
        ['2026-03-01', '1000'],
        ['2026-03-02', '1500'],
      ]),
      txs: [
        {
          id: 'tx-1',
          holdingId: 'h1',
          kind: 'deposit',
          quantity: '5',
          priceNative: '100',
          occurredAt: '2026-03-02T09:00:00.000Z',
        },
      ],
      vaults: { 'vault-1': [{ holdingId: 'h1', percentage: 40 }] },
    });

    const result = ok(await service.compute(request({ scope: { kind: 'vault', id: 'vault-1' } })));
    expect(result?.startValue).toBe('400');
    expect(result?.endValue).toBe('600');
    expect(result?.netExternalFlow).toBe('200');
    // Value and flow scale together, so the return is the unscaled one.
    expect(Number(result?.twr?.cumulative)).toBe(0);
  });

  test('a group scopes to its members', async () => {
    const service = install({
      holdings: [
        { id: 'h1', tokenId: 'token-btc', accountId: 'acc-1' },
        { id: 'h2', tokenId: 'token-eth', accountId: 'acc-2' },
      ],
      days: [
        { date: '2026-03-01', holdingId: 'h1', value: '100' },
        { date: '2026-03-01', holdingId: 'h2', value: '900' },
        { date: '2026-03-02', holdingId: 'h1', value: '200' },
        { date: '2026-03-02', holdingId: 'h2', value: '900' },
      ],
      txs: [],
      groupHoldings: { 'grp-1': ['h1'] },
    });

    const grouped = ok(await service.compute(request({ scope: { kind: 'group', id: 'grp-1' } })));
    expect(Number(grouped.twr?.cumulative)).toBe(1);
    const whole = ok(await service.compute(request()));
    expect(Number(whole.twr?.cumulative)).toBeCloseTo(0.1, 12);
  });

  test('a scope that is not this user is named, not returned as an empty series', async () => {
    const service = install({ holdings: ONE_HOLDING, days: [], txs: [] });
    expect(await service.compute(request({ scope: { kind: 'group', id: 'nope' } }))).toEqual({
      status: 'scope-not-found',
    });
    expect(await service.compute(request({ scope: { kind: 'holding', id: 'other' } }))).toEqual({
      status: 'scope-not-found',
    });
  });
});

describe('ReturnsService — the base currency reaches the query (SC-457 review)', () => {
  // The gate missed this once. `baseCurrencyId` was a required `string` that
  // no caller outside the tRPC router actually supplied, so it arrived
  // `undefined`, and postgres.js refuses the whole statement rather than
  // returning a wrong answer: every window threw against a real database with
  // 14,178 rollup rows. The stub could not see it because it ignored the
  // parameter. These four assert the parameter itself.

  test("it resolves the account's own base currency when the caller gives none", async () => {
    const service = install({
      holdings: ONE_HOLDING,
      days: days('h1', [
        ['2026-03-01', '1000'],
        ['2026-03-02', '1100'],
      ]),
      txs: [],
    });

    const result = ok(await service.compute(request()));
    // The value that reached the repository, not merely a non-empty series.
    expect(baseCurrencyCalls).toEqual([BASE]);
    expect(baseCurrencyCalls.every((value) => typeof value === 'string' && value.length > 0)).toBe(
      true
    );
    expect(result.baseCurrencyId).toBe(BASE);
    expect(Number(result.twr?.cumulative)).toBeCloseTo(0.1, 12);
  });

  test('an explicit baseCurrencyId overrides the account default', async () => {
    const service = install({
      holdings: ONE_HOLDING,
      userBaseCurrencyId: 'token-eur',
      days: days('h1', [
        ['2026-03-01', '1000'],
        ['2026-03-02', '1100'],
      ]),
      txs: [],
    });

    const result = ok(await service.compute(request({ baseCurrencyId: 'token-eur' })));
    expect(baseCurrencyCalls).toEqual(['token-eur']);
    expect(result.baseCurrencyId).toBe('token-eur');
  });

  test('an account with no base currency is refused by name, before any query', async () => {
    const service = install({
      holdings: ONE_HOLDING,
      userBaseCurrencyId: null,
      days: days('h1', [
        ['2026-03-01', '1000'],
        ['2026-03-02', '1100'],
      ]),
      txs: [],
    });

    expect(await service.compute(request())).toEqual({ status: 'no-base-currency' });
    // "Before any query" is the assertion: the rollup skips users with no base
    // currency, so there is nothing to read and no reason to try.
    expect(baseCurrencyCalls).toEqual([]);
  });

  test('a blank baseCurrencyId is treated as absent, not passed through', async () => {
    const service = install({
      holdings: ONE_HOLDING,
      days: days('h1', [
        ['2026-03-01', '1000'],
        ['2026-03-02', '1100'],
      ]),
      txs: [],
    });

    // A blank string is a legal query parameter that matches no row, so it
    // would answer "you have no history" to a malformed question.
    const result = ok(await service.compute(request({ baseCurrencyId: '   ' })));
    expect(baseCurrencyCalls).toEqual([BASE]);
    expect(result.coverage.measuredDays).toBe(2);
  });

  test('asking in a currency the rollup never wrote returns an empty series, not a converted one', async () => {
    const service = install({
      holdings: ONE_HOLDING,
      days: days('h1', [
        ['2026-03-01', '1000'],
        ['2026-03-02', '1100'],
      ]),
      txs: [],
    });

    const result = ok(await service.compute(request({ baseCurrencyId: 'token-jpy' })));
    expect(baseCurrencyCalls).toEqual(['token-jpy']);
    expect(result.coverage.measuredDays).toBe(0);
    expect(result.twr).toBeNull();
  });
});

describe('ReturnsService — it says what it could not measure', () => {
  test('a flow nothing could value is counted, not swallowed', async () => {
    const service = install({
      holdings: ONE_HOLDING,
      days: days('h1', [
        ['2026-03-01', '1000'],
        ['2026-03-02', '1500'],
      ]),
      txs: [
        {
          // No priceNative, and the held token has no route to base.
          id: 'tx-1',
          holdingId: 'h1',
          kind: 'deposit',
          quantity: '5',
          occurredAt: '2026-03-02T09:00:00.000Z',
        },
      ],
    });

    const result = ok(await service.compute(request()));
    expect(result?.coverage.unvaluedFlows).toBe(1);
    // And the consequence is visible: the deposit lands in the return.
    expect(Number(result?.twr?.cumulative)).toBeCloseTo(0.5, 12);
  });

  test('a day nothing could be priced on is dropped, not plotted as zero', async () => {
    const service = install({
      holdings: ONE_HOLDING,
      days: [
        { date: '2026-03-01', holdingId: 'h1', value: '1000' },
        { date: '2026-03-02', holdingId: 'h1', value: '0', known: 0, quality: 'unknown' },
        { date: '2026-03-03', holdingId: 'h1', value: '1100' },
      ],
      txs: [],
    });

    const result = ok(await service.compute(request()));
    expect(result?.coverage.measuredDays).toBe(2);
    expect(result?.coverage.windowDays).toBe(3);
    // Not -100% then +infinity.
    expect(Number(result?.twr?.cumulative)).toBeCloseTo(0.1, 12);
  });

  test('days below full coverage are counted', async () => {
    const service = install({
      holdings: ONE_HOLDING,
      days: [
        { date: '2026-03-01', holdingId: 'h1', value: '1000' },
        { date: '2026-03-02', holdingId: 'h1', value: '1100', quality: 'partial' },
      ],
      txs: [],
    });
    const result = ok(await service.compute(request()));
    expect(result?.coverage.daysNotFullyCovered).toBe(1);
  });

  test('the held-token route values a flow when no execution rate was recorded', async () => {
    const service = install({
      holdings: ONE_HOLDING,
      days: days('h1', [
        ['2026-03-01', '1000'],
        ['2026-03-02', '1500'],
      ]),
      txs: [
        {
          id: 'tx-1',
          holdingId: 'h1',
          kind: 'deposit',
          quantity: '5',
          occurredAt: '2026-03-02T09:00:00.000Z',
        },
      ],
      rates: { 'token-btc': '100' },
    });

    const result = ok(await service.compute(request()));
    expect(result?.coverage.unvaluedFlows).toBe(0);
    expect(result?.netExternalFlow).toBe('500');
    expect(Number(result?.twr?.cumulative)).toBe(0);
  });
});

describe('ReturnsService — the price graph is consulted once, not once per flow (SC-471)', () => {
  // Measured against production before this changed: 537 sequential
  // `token_prices` lookups were 51.2 of a 53.1-second `ytd` request, 792 were
  // 70.5 of 71.2 seconds over `all`, and the daily series query and the whole
  // of the Decimal arithmetic were 0.5s and 0.02s of it. The count is
  // therefore the thing worth asserting: a per-flow lookup is the defect, and
  // a scalar timing assertion in a unit test would be a flake.
  const MANY_FLOWS = 40;

  function fixtureWithFlows(count: number): Fixture {
    return {
      holdings: [{ id: 'h1', tokenId: 'token-eur', accountId: 'acc-1' }],
      days: days('h1', [
        ['2026-01-01', '1000'],
        ['2026-03-01', '1000'],
      ]),
      // Every flow needs the SAME conversion, so a per-flow lookup and a
      // prefetch are indistinguishable by their answers and separable only
      // by how many times the graph was asked.
      rates: { 'token-eur': '2' },
      txs: Array.from({ length: count }, (_, i) => ({
        id: `tx-${i}`,
        holdingId: 'h1',
        kind: 'deposit',
        quantity: '1',
        occurredAt: `2026-02-${String((i % 27) + 1).padStart(2, '0')}T10:00:00.000Z`,
      })),
    };
  }

  test('one prefetch per compute, whatever the flow count', async () => {
    const service = install(fixtureWithFlows(MANY_FLOWS));
    const result = ok(await service.compute(request()));

    expect(priceLookupBuilds.length).toBe(1);
    expect(convertCalls.length).toBe(MANY_FLOWS);
    // Every conversion reads the prefetch. One that did not would be a DB
    // round-trip, which is the entire cost this removes.
    expect(convertCalls.every((call) => call.withLookup)).toBe(true);
    expect(result.netExternalFlow).toBe(String(MANY_FLOWS * 2));
  });

  test('the prefetch covers the held token AND the token an execution rate is quoted in', async () => {
    // The two routes `valueTransactionInBase` can take. A prefetch built only
    // from held tokens would miss the second, and `PriceLookup.covers` would
    // then send it to the database — correct, but not fast.
    const service = install({
      holdings: [{ id: 'h1', tokenId: 'token-eur', accountId: 'acc-1' }],
      days: days('h1', [
        ['2026-01-01', '1000'],
        ['2026-03-01', '1000'],
      ]),
      rates: { 'token-eur': '2', 'token-gbp': '3' },
      txs: [
        {
          id: 'tx-1',
          holdingId: 'h1',
          kind: 'deposit',
          quantity: '1',
          occurredAt: '2026-02-01T10:00:00.000Z',
        },
        {
          id: 'tx-2',
          holdingId: 'h1',
          kind: 'deposit',
          quantity: '1',
          occurredAt: '2026-02-02T10:00:00.000Z',
          tokenId: 'token-gbp',
        },
      ],
    });
    await service.compute(request());

    expect(priceLookupBuilds.length).toBe(1);
    expect(priceLookupBuilds[0]).toEqual(['token-eur', 'token-gbp']);
  });

  test('no flows in the window means no prefetch at all', async () => {
    // Most accounts in the product are this one. It used to pay for a query
    // whose result nothing would read.
    const service = install({
      holdings: ONE_HOLDING,
      days: days('h1', [
        ['2026-01-01', '1000'],
        ['2026-03-01', '1200'],
      ]),
      txs: [],
    });
    const result = ok(await service.compute(request()));

    expect(priceLookupBuilds.length).toBe(0);
    expect(Number(result.twr?.cumulative)).toBeCloseTo(0.2, 12);
  });
});

describe('ReturnsService — how much of it was the exchange rate (SC-458)', () => {
  const GBP = 'token-gbp';
  const CAD = 'token-cad';

  /** `(1+asset)(1+currency)` must land on `1+base` on the numbers reported. */
  function composed(result: ReturnsResult): number {
    const attribution = result.attribution as NonNullable<ReturnsResult['attribution']>;
    return new Decimal(attribution.assetReturn)
      .plus(1)
      .mul(new Decimal(attribution.currencyReturn).plus(1))
      .minus(1)
      .toNumber();
  }

  // The headline the ticket is written for. A GBP balance on a USD base did
  // not go up; the rate did. Every figure in the product converts to base
  // before it is shown, so until now the two were indistinguishable.
  test('a GBP balance on a USD base: the whole 10% is the rate', async () => {
    const service = install({
      holdings: [{ id: 'h1', tokenId: GBP, accountId: 'acc-1' }],
      tokens: [{ id: GBP, symbol: 'GBP', typeCode: 'fiat' }],
      days: days('h1', [
        ['2026-01-01', '1000'],
        ['2026-03-01', '1100'],
      ]),
      txs: [],
      fxRates: { [GBP]: { '2026-01-01': '1.0', '2026-03-01': '1.1' } },
    });
    const result = ok(await service.compute(request()));

    expect(Number(result.twr?.cumulative)).toBeCloseTo(0.1, 12);
    expect(Number(result.attribution?.assetReturn)).toBeCloseTo(0, 12);
    expect(Number(result.attribution?.currencyReturn)).toBeCloseTo(0.1, 12);
    expect(result.attribution?.attributedPeriods).toBe(1);
    expect(result.attribution?.unattributedPeriods).toBe(0);
    expect(result.attribution?.currencies).toEqual([{ currencyTokenId: GBP, endWeight: '1' }]);
  });

  test('two currencies and a real asset move recompose to the base figure', async () => {
    // 600 in GBP cash that does nothing while GBP gains 10%, and 400 in a
    // Toronto-listed ETF up 20% in CAD while CAD does nothing.
    const service = install({
      holdings: [
        { id: 'h1', tokenId: GBP, accountId: 'acc-1' },
        { id: 'h2', tokenId: 'token-xeqt', accountId: 'acc-1' },
      ],
      tokens: [
        { id: GBP, symbol: 'GBP', typeCode: 'fiat' },
        { id: 'token-xeqt', symbol: 'XEQT', typeCode: 'stock', marketSegment: 'TO' },
      ],
      fiatTokens: [{ id: CAD, symbol: 'CAD' }],
      days: [
        ...days('h1', [
          ['2026-01-01', '600'],
          ['2026-03-01', '660'],
        ]),
        ...days('h2', [
          ['2026-01-01', '400'],
          ['2026-03-01', '480'],
        ]),
      ],
      txs: [],
      fxRates: {
        [GBP]: { '2026-01-01': '1.0', '2026-03-01': '1.1' },
        [CAD]: { '2026-01-01': '1.0', '2026-03-01': '1.0' },
      },
    });
    const result = ok(await service.compute(request()));

    expect(Number(result.twr?.cumulative)).toBeCloseTo(0.14, 12);
    expect(Number(result.attribution?.assetReturn)).toBeCloseTo(0.08, 12);
    expect(Number(result.attribution?.currencyReturn)).toBeCloseTo(1.14 / 1.08 - 1, 12);
    expect(Number(result.attribution?.baseReturn)).toBeCloseTo(0.14, 12);
    expect(composed(result)).toBeCloseTo(0.14, 12);
  });

  test('a portfolio held entirely in the base currency costs nothing to attribute', async () => {
    // No rate exists between a currency and itself, so no prefetch and no
    // conversion is issued — the common case pays nothing for the split, and
    // the answer is still a measurement rather than an absence.
    const service = install({
      holdings: [{ id: 'h1', tokenId: BASE, accountId: 'acc-1' }],
      tokens: [{ id: BASE, symbol: 'USD', typeCode: 'fiat' }],
      days: days('h1', [
        ['2026-01-01', '1000'],
        ['2026-03-01', '1200'],
      ]),
      txs: [],
    });
    const result = ok(await service.compute(request()));

    expect(priceLookupBuilds.length).toBe(0);
    expect(convertCalls.length).toBe(0);
    expect(Number(result.attribution?.assetReturn)).toBeCloseTo(0.2, 12);
    expect(Number(result.attribution?.currencyReturn)).toBeCloseTo(0, 12);
  });

  test('the rates are prefetched ONCE, whatever the window length (SC-471 still holds)', async () => {
    // A rate per currency per day is exactly the shape SC-471 removed: 537
    // sequential lookups were 51.2 of a 53.1-second request. Every conversion
    // below reads the in-memory index instead, and one prefetch serves all of
    // them however long the window.
    const dates = Array.from(
      { length: 60 },
      (_, i) => `2026-01-${String((i % 28) + 1).padStart(2, '0')}`
    );
    const unique = [...new Set(dates)].sort();
    const service = install({
      holdings: [{ id: 'h1', tokenId: GBP, accountId: 'acc-1' }],
      tokens: [{ id: GBP, symbol: 'GBP', typeCode: 'fiat' }],
      days: days(
        'h1',
        unique.map((date) => [date, '1000'] as [string, string])
      ),
      txs: [],
      fxRates: { [GBP]: '1.0' },
    });
    const result = ok(await service.compute(request()));

    expect(unique.length).toBeGreaterThan(20);
    expect(priceLookupBuilds.length).toBe(1);
    expect(priceLookupBuilds[0]).toEqual([GBP]);
    expect(convertCalls.every((call) => call.withLookup)).toBe(true);
    expect(result.attribution?.attributedPeriods).toBe(unique.length - 1);
  });

  test('a rate nobody could read costs its period and is counted, not assumed away', async () => {
    const service = install({
      holdings: [{ id: 'h1', tokenId: GBP, accountId: 'acc-1' }],
      tokens: [{ id: GBP, symbol: 'GBP', typeCode: 'fiat' }],
      days: days('h1', [
        ['2026-01-01', '1000'],
        ['2026-02-01', '1100'],
        ['2026-03-01', '1210'],
      ]),
      txs: [],
      fxRates: { [GBP]: { '2026-01-01': '1.0', '2026-02-01': '1.0', '2026-03-01': null } },
    });
    const result = ok(await service.compute(request()));

    // The headline TWR still chains both periods — the value series is intact.
    expect(Number(result.twr?.cumulative)).toBeCloseTo(0.21, 12);
    expect(result.attribution?.attributedPeriods).toBe(1);
    expect(result.attribution?.unpricedCurrencyPeriods).toBe(1);
    // And `baseReturn` covers only what was attributed, so the identity holds
    // on the printed numbers rather than on two different period sets.
    expect(Number(result.attribution?.baseReturn)).toBeCloseTo(0.1, 12);
    expect(composed(result)).toBeCloseTo(0.1, 12);
  });

  test('an asset nothing can place in a currency yields no split at all', async () => {
    // A private valuation says nothing about its own currency. Reporting
    // "0% of this was the exchange rate" would be a claim, not a measurement.
    const service = install({
      holdings: [{ id: 'h1', tokenId: 'token-acme', accountId: 'acc-1' }],
      tokens: [{ id: 'token-acme', symbol: 'ACME', typeCode: 'private-company' }],
      days: days('h1', [
        ['2026-01-01', '1000'],
        ['2026-03-01', '1200'],
      ]),
      txs: [],
    });
    const result = ok(await service.compute(request()));

    expect(Number(result.twr?.cumulative)).toBeCloseTo(0.2, 12);
    expect(result.attribution).toBeNull();
  });

  test('a deposit into a foreign holding is not currency return', async () => {
    // The flow is bucketed by the currency of the holding it moved and
    // re-expressed at the opening rate alongside the value, so a contribution
    // cancels out of the asset leg exactly as it does out of the TWR.
    const service = install({
      holdings: [{ id: 'h1', tokenId: GBP, accountId: 'acc-1' }],
      tokens: [{ id: GBP, symbol: 'GBP', typeCode: 'fiat' }],
      days: days('h1', [
        ['2026-01-01', '1000'],
        ['2026-03-01', '2200'],
      ]),
      // 1000 GBP in, valued at the day's 1.1 → 1100 base.
      txs: [
        {
          id: 'tx-1',
          holdingId: 'h1',
          kind: 'deposit',
          quantity: '1000',
          occurredAt: '2026-02-01T10:00:00.000Z',
          priceNative: '1.1',
        },
      ],
      fxRates: { [GBP]: { '2026-01-01': '1.0', '2026-03-01': '1.1' } },
    });
    const result = ok(await service.compute(request()));

    expect(result.netExternalFlow).toBe('1100');
    expect(Number(result.twr?.cumulative)).toBeCloseTo(0.1, 12);
    expect(Number(result.attribution?.assetReturn)).toBeCloseTo(0, 12);
    expect(Number(result.attribution?.currencyReturn)).toBeCloseTo(0.1, 12);
  });
});
