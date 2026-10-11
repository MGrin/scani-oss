process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { HISTORY_REBUILD_JOB_NAME } from '@scani/shared';
import Decimal from 'decimal.js';
import { Container } from 'typedi';
import type { CoverageFacts } from '../../../src/lib/returns/flow-coverage';
import { GroupRepository } from '../../../src/repositories/GroupRepository';
import { HoldingCoverageRepository } from '../../../src/repositories/HoldingCoverageRepository';
import { HoldingRepository } from '../../../src/repositories/HoldingRepository';
import { HoldingTransactionRepository } from '../../../src/repositories/HoldingTransactionRepository';
import { PortfolioValueDailyRepository } from '../../../src/repositories/PortfolioValueDailyRepository';
import { TokenRepository } from '../../../src/repositories/TokenRepository';
import { UserJobRepository } from '../../../src/repositories/UserJobRepository';
import { UserRepository } from '../../../src/repositories/UserRepository';
import { VaultRepository } from '../../../src/repositories/VaultRepository';
import {
  InTransitService,
  type OpenTransit,
} from '../../../src/services/portfolio/InTransitService';
import { PriceReader } from '../../../src/services/pricing/PriceReader';
import { AssetCurrencyService } from '../../../src/services/returns/AssetCurrencyService';
import { DriftLedgerService } from '../../../src/services/returns/DriftLedgerService';
import { ExternalFlowService } from '../../../src/services/returns/ExternalFlowService';
import { ReturnsScopeResolver } from '../../../src/services/returns/ReturnsScopeResolver';
import {
  type ReturnsOutcome,
  type ReturnsRequest,
  type ReturnsResult,
  ReturnsService,
} from '../../../src/services/returns/ReturnsService';
import { ReturnsSharedLoads } from '../../../src/services/returns/ReturnsSharedLoads';
import { restoreContainerAfterAll } from '../../../test/helpers/container';
import { seriesFrom } from '../../../test/helpers/price-series';

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

/** The tokens each series load was asked for, one entry per load (SC-471). */
const seriesLoads: string[][] = [];

/** Every series load's asks, in the same order. */
const seriesAsks: Array<ReadonlyArray<{ tokenId: string; at: Date }>> = [];

/** Every token a flow valuation read from a series. */
const seriesReads: string[] = [];

interface DayRow {
  date: string;
  holdingId: string;
  value: string;
  stale?: number;
  /** Defaults to 1 — the day was priced. 0 means nothing could be priced. */
  known?: number;
  quality?: string;
  /** Defaults to 1. 0 is a holding the day does not contain at all (SC-1323). */
  total?: number;
  /** 1 when the day's balance was drawn on a line between two observations. */
  interpolated?: number;
  /** 1 when the day's balance was projected from before the holding's first record. */
  beforeRecords?: number;
}

interface TxRow {
  id: string;
  holdingId: string;
  kind: string;
  quantity: string;
  occurredAt: string;
  /** Per-unit price, in the base currency unless `priceNativeTokenId` says otherwise. */
  priceNative?: string | null;
  priceNativeTokenId?: string;
  tokenId?: string;
}

interface Fixture {
  /** A full-history recompute for this user is queued or running. */
  rebuildPending?: boolean;
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
  incomplete?: boolean;
  /** Only these holdings lack a complete ledger (SC-1421). */
  incompleteHoldings?: string[];
  /** Holdings on liability (loan, card) accounts (SC-1640). */
  debtHoldings?: string[];
  /** Holdings whose ledger rebuilds below zero from their earliest balance (SC-1444). */
  negativeRebuild?: string[];
  unresolvedResidual?: string;
  /** Per-holding coverage facts beyond the claim, for SC-1427's partial ledgers. */
  coverage?: Record<string, Partial<CoverageFacts>>;
  /** Holdings with no coverage row at all, as the reconciler never ran (SC-1448). */
  noCoverage?: string[];
  /** First reading of a position with no ledger whose readings never moved (SC-1448). */
  unchangedSince?: Record<string, string>;
  groupHoldings?: Record<string, string[]>;
  /** Money in transit, by day and destination; the rows the repository adds at user scope (SC-1675). */
  transitDays?: Array<{ date: string; holdingId: string; value: string }>;
  /** Transfers answered internal to a provider-fed holding (SC-1675). */
  transits?: OpenTransit[];
  vaults?: Record<string, Array<{ holdingId: string; percentage: number }>>;
}

/** One unit of `fromTokenId` in `toTokenId`: the FX table first, then the flow rates. */
function rateOf(
  fixture: Fixture,
  fromTokenId: string,
  toTokenId: string,
  at: Date
): Decimal | null {
  if (fromTokenId === toTokenId) return new Decimal(1);
  const fx = fixture.fxRates?.[fromTokenId];
  if (fx !== undefined) {
    const resolved = typeof fx === 'string' ? fx : (fx[at.toISOString().slice(0, 10)] ?? null);
    return resolved === null ? null : new Decimal(resolved);
  }
  const rate = fixture.rates?.[fromTokenId];
  return rate ? new Decimal(rate) : null;
}

function install(fixture: Fixture): ReturnsService {
  const holdingById = new Map(fixture.holdings.map((h) => [h.id, h]));

  Container.set(HoldingCoverageRepository, {
    findManyByHoldingIds: async (ids: string[]) =>
      new Map(
        ids
          .filter((id) => !(fixture.noCoverage ?? []).includes(id))
          .map((id) => [
            id,
            {
              hasCompleteTxHistory:
                !fixture.incomplete && !(fixture.incompleteHoldings ?? []).includes(id),
              unexplainedResidual: fixture.unresolvedResidual ?? null,
              openingBalanceQuantity: null,
              txSources: [],
              firstTxAt: null,
              lastReconciledAt: null,
              ...fixture.coverage?.[id],
            },
          ])
      ),
    findRebuildGoesNegative: async (ids: string[]) =>
      new Set(ids.filter((id) => (fixture.negativeRebuild ?? []).includes(id))),
    findUnchangedSinceFirstReading: async (ids: string[]) =>
      new Map(
        ids.flatMap((id) => {
          const since = fixture.unchangedSince?.[id];
          return since ? [[id, since] as const] : [];
        })
      ),
  } as never);

  Container.set(PortfolioValueDailyRepository, {
    findIncludedHoldingValueRange: async (
      _userId: string,
      baseCurrencyId: string,
      from: Date,
      to: Date,
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
      // As the repository does: at user scope a day's transit adds to its destination.
      const transitOf = (d: DayRow) =>
        wanted
          ? undefined
          : fixture.transitDays?.find((t) => t.date === d.date && t.holdingId === d.holdingId);
      return fixture.days
        .filter((d) => d.date >= fromStr && d.date <= toStr)
        .filter((d) => !wanted || wanted.has(d.holdingId))
        .map((d) => ({
          snapshotDate: d.date,
          holdingId: d.holdingId,
          totalValue: transitOf(d)
            ? new Decimal(d.value).add(transitOf(d)?.value ?? '0').toString()
            : d.value,
          costBasis: null,
          realizedPnl: null,
          unrealizedPnl: null,
          coverageQuality: d.quality ?? 'full',
          holdingsWithKnownValue: d.known ?? 1,
          holdingsTotal: d.total ?? 1,
          holdingsUnpriceable: 0,
          holdingsStalePriced: d.stale ?? 0,
          holdingsInterpolated: d.interpolated ?? 0,
          holdingsBeforeRecords: d.beforeRecords ?? 0,
          holdingsBasisUnknown: 0,
          transfersUnreviewed: 0,
        }));
    },
    // Derived from the SAME `fixture.days` as the range read above, and
    // filtered the same way, so the two cannot drift apart inside a test and
    // let `hasHistory` agree with `compute` for the wrong reason (SC-1306).
    findLatestMeasuredDays: async (
      _userId: string,
      baseCurrencyId: string,
      from: Date,
      to: Date,
      limit: number,
      _tx?: unknown,
      holdingIds?: readonly string[]
    ) => {
      if (baseCurrencyId !== (fixture.userBaseCurrencyId ?? BASE)) return [];
      const fromStr = from.toISOString().slice(0, 10);
      const toStr = to.toISOString().slice(0, 10);
      const wanted = holdingIds ? new Set(holdingIds) : null;
      const measured = fixture.days
        .filter((d) => d.date >= fromStr && d.date <= toStr)
        .filter((d) => !wanted || wanted.has(d.holdingId))
        .filter((d) => (d.known ?? 1) > 0)
        .map((d) => d.date);
      return [...new Set(measured)].sort().reverse().slice(0, limit);
    },
  } as never);

  Container.set(UserJobRepository, {
    findInFlightByName: async (_userId: string, jobName: string) =>
      fixture.rebuildPending && jobName === HISTORY_REBUILD_JOB_NAME ? { jobName } : null,
  } as unknown as UserJobRepository);
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
    findIdsIncludedInTotal: async (ids: readonly string[]) => new Set(ids),
    findIdsOnLiabilityAccounts: async (ids: readonly string[]) =>
      new Set(ids.filter((id) => (fixture.debtHoldings ?? []).includes(id))),
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
          transferReview: 'left_control',
          quantity: t.quantity,
          occurredAt: new Date(t.occurredAt),
          priceNative: t.priceNative ?? null,
          priceNativeTokenId: t.priceNativeTokenId ?? (t.priceNative ? BASE : null),
          tokenId: t.tokenId ?? holdingById.get(t.holdingId)?.tokenId ?? 'token-x',
        }))
        .filter((t) => t.occurredAt > from && t.occurredAt <= to)
        .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
    },
  } as never);

  // Flows and the FX attribution each read one series, answering from the
  // fixture's rates.
  Container.set(PriceReader, {
    series: async (asks: ReadonlyArray<{ tokenId: string; at: Date }>, baseTokenId: string) => {
      seriesLoads.push([...new Set(asks.map((ask) => ask.tokenId))].sort());
      seriesAsks.push(asks);
      return seriesFrom(asks, baseTokenId, (amount, tokenId, base, at) => {
        seriesReads.push(tokenId);
        const rate = rateOf(fixture, tokenId, base, at);
        return rate === null ? null : { amount: amount.mul(rate), stale: false };
      });
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
  Container.set(DriftLedgerService, {
    forHoldings: async () => new Map(),
  } as unknown as DriftLedgerService);
  Container.set(InTransitService, {
    openTransits: async () => fixture.transits ?? [],
  } as unknown as InTransitService);
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
  seriesLoads.length = 0;
  seriesAsks.length = 0;
  seriesReads.length = 0;
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
    // Funded from zero, and that is its only period: nothing is left to
    // measure, so it says so rather than printing 0%.
    expect(result?.coverage.skippedPeriods).toBe(1);
    expect(result?.eligibility.eligible).toBe(false);
    expect(result?.eligibility.reasons).toEqual(['insufficient-history']);
    expect(result?.twr).toBeNull();
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
    // The day it was funded from zero cannot be measured and is counted as
    // such; the day after it can, and that is the whole return (SC-1421).
    expect(result?.coverage.skippedPeriods).toBe(1);
    expect(result?.eligibility.eligible).toBe(true);
    expect(Number(result?.twr?.cumulative)).toBeCloseTo(0.1, 12);
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
    expect(result.eligibility.eligible).toBe(false);
    expect(result.eligibility.reasons).toContain('missing-valuation');
    expect(result.twr).toBeNull();
    expect(result.attribution).toBeNull();
    expect(result.endValue).toBe('1500');
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

describe('ReturnsService — prices are loaded once, not once per flow (SC-471)', () => {
  const MANY_FLOWS = 40;

  function fixtureWithFlows(count: number): Fixture {
    return {
      holdings: [{ id: 'h1', tokenId: 'token-eur', accountId: 'acc-1' }],
      days: days('h1', [
        ['2026-01-01', '1000'],
        ['2026-03-01', '1000'],
      ]),
      // Every flow needs the SAME price, so a per-flow load and one series
      // are indistinguishable by their answers and separable only by how
      // many times prices were loaded.
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

  test('one series per compute, whatever the flow count', async () => {
    const service = install(fixtureWithFlows(MANY_FLOWS));
    const result = ok(await service.compute(request()));

    expect(seriesLoads.length).toBe(1);
    expect(seriesReads.length).toBe(MANY_FLOWS);
    expect(result.netExternalFlow).toBe(String(MANY_FLOWS * 2));
  });

  test('the series asks the held token AND the token an execution rate is quoted in', async () => {
    // The two routes a flow's valuation can take. A series that missed the
    // second would throw when it is read: the asks come from the same rule
    // the valuation reads by (`valuationInstantsOf`).
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
          priceNative: '1',
          priceNativeTokenId: 'token-gbp',
        },
      ],
    });
    const result = ok(await service.compute(request()));

    expect(seriesLoads).toEqual([['token-eur', 'token-gbp']]);
    // 1 EUR at 2, then 1 unit at 1 GBP at 3.
    expect(result.netExternalFlow).toBe('5');
  });

  test('a flow dated today is valued inside the series it was loaded with', async () => {
    const service = install({
      holdings: [{ id: 'h1', tokenId: 'token-eur', accountId: 'acc-1' }],
      days: days('h1', [
        ['2026-03-01', '1000'],
        ['2026-03-10', '1002'],
      ]),
      rates: { 'token-eur': '2' },
      txs: [
        {
          id: 'tx-today',
          holdingId: 'h1',
          kind: 'deposit',
          quantity: '1',
          occurredAt: '2026-03-10T08:00:00.000Z',
        },
      ],
    });
    const result = ok(await service.compute(request()));

    // Today has no close yet, so the flow is asked and read at `now`.
    expect(seriesAsks[0]?.map((ask) => ask.at.toISOString())).toEqual([NOW.toISOString()]);
    expect(result.netExternalFlow).toBe('2');
  });

  test('no flows in the window means no load at all', async () => {
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

    expect(seriesLoads.length).toBe(0);
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
    // No rate exists between a currency and itself, so no series is loaded —
    // the common case pays nothing for the split, and the answer is still a
    // measurement rather than an absence.
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

    expect(seriesLoads).toEqual([]);
    expect(Number(result.attribution?.assetReturn)).toBeCloseTo(0.2, 12);
    expect(Number(result.attribution?.currencyReturn)).toBeCloseTo(0, 12);
  });

  test('the rates come from one series, whatever the window length (SC-471 still holds)', async () => {
    // A rate per currency per day is exactly the shape SC-471 removed: 537
    // sequential lookups were 51.2 of a 53.1-second request. One series
    // serves every day however long the window.
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
    expect(seriesLoads).toEqual([[GBP]]);
    expect(result.attribution?.attributedPeriods).toBe(unique.length - 1);
  });

  test('the last date of a returns window does not throw: today is asked at the run’s instant', async () => {
    const service = install({
      holdings: [{ id: 'h1', tokenId: GBP, accountId: 'acc-1' }],
      tokens: [{ id: GBP, symbol: 'GBP', typeCode: 'fiat' }],
      days: days('h1', [
        ['2026-03-01', '1000'],
        ['2026-03-10', '1100'],
      ]),
      txs: [],
      fxRates: { [GBP]: '1.0' },
    });
    const result = ok(await service.compute(request()));

    // A past day at its close; today, which has no close yet, at `now`.
    expect(seriesAsks).toHaveLength(1);
    expect(seriesAsks[0]?.map((ask) => [ask.tokenId, ask.at.toISOString()])).toEqual([
      [GBP, '2026-03-01T23:59:59.999Z'],
      [GBP, NOW.toISOString()],
    ]);
    expect(result.attribution?.attributedPeriods).toBe(1);
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

describe('ReturnsService.hasHistory — one bit, and the SAME bit (SC-1306)', () => {
  const CASES: Array<{ name: string; days: DayRow[]; window?: ReturnsRequest['window'] }> = [
    { name: 'nothing measured at all', days: [] },
    { name: 'one measured day', days: days('h1', [['2026-03-01', '1000']]) },
    {
      name: 'two measured days',
      days: days('h1', [
        ['2026-03-01', '1000'],
        ['2026-03-02', '1100'],
      ]),
    },
    {
      name: 'one day inside the window and an anchor before it',
      days: days('h1', [
        ['2025-12-20', '900'],
        ['2026-03-01', '1000'],
      ]),
      window: { kind: 'ytd' },
    },
    {
      name: 'two days, BOTH before a YTD window',
      days: days('h1', [
        ['2025-11-20', '900'],
        ['2025-12-20', '950'],
      ]),
      window: { kind: 'ytd' },
    },
    {
      name: 'days that exist but nothing on them could be priced',
      days: [
        { date: '2026-03-01', holdingId: 'h1', value: '0', known: 0 },
        { date: '2026-03-02', holdingId: 'h1', value: '0', known: 0 },
      ],
    },
  ];

  for (const testCase of CASES) {
    test(`agrees with compute: ${testCase.name}`, async () => {
      const service = install({ holdings: ONE_HOLDING, days: testCase.days, txs: [] });
      const req = request(testCase.window ? { window: testCase.window } : {});
      const outcome = await service.compute(req);
      // The frontend's own rule: the card shows money when the engine produced
      // a TWR, and `returnsView` returns null without one.
      const computeSaysYes = outcome.status === 'ok' && outcome.returns.twr !== null;
      expect(await service.hasHistory(req)).toBe(computeSaysYes);
    });
  }

  test('reads the series once, not the whole engine', async () => {
    // The control on the control: an implementation that just called `compute`
    // would agree with it in every case above and fix nothing.
    const service = install({
      holdings: ONE_HOLDING,
      days: days('h1', [
        ['2026-03-01', '1000'],
        ['2026-03-02', '1100'],
      ]),
      txs: [
        { id: 't1', holdingId: 'h1', kind: 'deposit', quantity: '1', occurredAt: '2026-03-02' },
      ],
      rates: { 'token-btc': '100' },
    });
    baseCurrencyCalls.length = 0;
    seriesLoads.length = 0;

    expect(await service.hasHistory(request())).toBe(true);
    // `findIncludedHoldingValueRange` is the read that records a base
    // currency; the flow valuation is what loads a series.
    expect(baseCurrencyCalls).toEqual([]);
    expect(seriesLoads).toEqual([]);
  });

  test('an account with no base currency is a no, not a throw', async () => {
    const service = install({
      holdings: ONE_HOLDING,
      days: days('h1', [
        ['2026-03-01', '1000'],
        ['2026-03-02', '1100'],
      ]),
      txs: [],
      userBaseCurrencyId: null,
    });
    expect(await service.hasHistory(request())).toBe(false);
  });

  test("a scope that is not the caller's is a no", async () => {
    const service = install({
      holdings: ONE_HOLDING,
      days: days('h1', [
        ['2026-03-01', '1000'],
        ['2026-03-02', '1100'],
      ]),
      txs: [],
    });
    expect(await service.hasHistory(request({ scope: { kind: 'account', id: 'acc-nope' } }))).toBe(
      false
    );
  });
});

/**
 * A holding's arrival is money put in, not a return (SC-1323).
 *
 * The rollup counts a holding only from its first record, so a holding added
 * mid-window steps the value series up on the day it appears. With nothing
 * booked against that step, a 0.5 BTC added by hand read as a market gain of
 * its whole value. The step is funding, the same as `opening_balance`.
 */
describe('ReturnsService — a holding that appears mid-window', () => {
  const TWO = [
    { id: 'h1', tokenId: 'token-btc', accountId: 'acc-1' },
    { id: 'h2', tokenId: 'token-eth', accountId: 'acc-2' },
  ];
  // What the rollup writes for a holding on a day before its first record:
  // an empty slice, so nothing counted and `unknown` (SC-1323).
  const before = (date: string): DayRow => ({
    date,
    holdingId: 'h2',
    value: '0',
    known: 0,
    total: 0,
    quality: 'unknown',
  });

  test('its first value is a contribution, so a flat portfolio stays at 0%', async () => {
    const service = install({
      holdings: TWO,
      days: [
        ...days('h1', [
          ['2026-03-01', '1000'],
          ['2026-03-02', '1000'],
          ['2026-03-03', '1000'],
        ]),
        before('2026-03-01'),
        before('2026-03-02'),
        ...days('h2', [['2026-03-03', '500']]),
      ],
      txs: [],
    });

    const result = ok(await service.compute(request()));
    expect(result.netExternalFlow).toBe('500');
    expect(result.endValue).toBe('1500');
    expect(Number(result.twr?.cumulative)).toBeCloseTo(0, 12);
    // The days before it arrived are fully covered: it was not there to price.
    expect(result.coverage.daysNotFullyCovered).toBe(0);
  });

  test('a gain after it arrives is still a gain', async () => {
    const service = install({
      holdings: TWO,
      days: [
        ...days('h1', [
          ['2026-03-01', '1000'],
          ['2026-03-02', '1000'],
          ['2026-03-03', '1000'],
        ]),
        before('2026-03-01'),
        ...days('h2', [
          ['2026-03-02', '500'],
          ['2026-03-03', '750'],
        ]),
      ],
      txs: [],
    });

    const result = ok(await service.compute(request()));
    expect(result.netExternalFlow).toBe('500');
    // 1000 -> 1500 is all funding; 1500 -> 1750 is +1/6.
    expect(Number(result.twr?.cumulative)).toBeCloseTo(250 / 1500, 12);
  });

  test('a deposit already on its ledger that day is not counted twice', async () => {
    const service = install({
      holdings: TWO,
      days: [
        ...days('h1', [
          ['2026-03-01', '1000'],
          ['2026-03-02', '1000'],
        ]),
        before('2026-03-01'),
        ...days('h2', [['2026-03-02', '500']]),
      ],
      txs: [
        {
          id: 'tx-dep',
          holdingId: 'h2',
          kind: 'deposit',
          quantity: '5',
          priceNative: '100',
          occurredAt: '2026-03-02T10:00:00.000Z',
          tokenId: 'token-eth',
        },
      ],
    });

    const result = ok(await service.compute(request()));
    expect(result.netExternalFlow).toBe('500');
    expect(Number(result.twr?.cumulative)).toBeCloseTo(0, 12);
  });

  // The control: a holding measured from the window's first day is part of
  // the opening value, and nothing is booked for it.
  test('a holding present from the first day books nothing', async () => {
    const service = install({
      holdings: TWO,
      days: [
        ...days('h1', [
          ['2026-03-01', '1000'],
          ['2026-03-02', '1000'],
        ]),
        ...days('h2', [
          ['2026-03-01', '500'],
          ['2026-03-02', '500'],
        ]),
      ],
      txs: [],
    });

    const result = ok(await service.compute(request()));
    expect(result.netExternalFlow).toBe('0');
    expect(result.startValue).toBe('1500');
  });
});

describe('Returns eligibility protects recorded change', () => {
  const fixture = {
    holdings: ONE_HOLDING,
    days: [
      { date: '2026-03-01', holdingId: 'h1', value: '1000' },
      { date: '2026-03-10', holdingId: 'h1', value: '1500' },
    ],
    txs: [],
  };
  test('incomplete flows and unexplained residuals cannot be reported as gain', async () => {
    for (const extra of [{ incomplete: true }, { unresolvedResidual: '500' }]) {
      const result = ok(await install({ ...fixture, ...extra }).compute(request()));
      expect(result?.eligibility.eligible).toBe(false);
      expect(result?.twr).toBeNull();
      expect(result?.attribution).toBeNull();
      expect(result?.endValue).toBe('1500');
      expect(result?.startValue).toBe('1000');
    }
  });
  test('a pending history recompute and stale valuation both withhold performance', async () => {
    expect(
      ok(await install({ ...fixture, rebuildPending: true }).compute(request()))?.eligibility
        .reasons
    ).toContain('rebuilding-history');
    expect(ok(await install(fixture).compute(request()))?.eligibility.eligible).toBe(true);
    expect(
      ok(
        await install({
          ...fixture,
          days: fixture.days.map((day) => ({ ...day, stale: 1 })),
        }).compute(request())
      )?.eligibility.reasons
    ).toContain('stale-valuation');
  });
});

describe('Returns eligibility is decided per holding (SC-1421)', () => {
  const TWO = [
    { id: 'h1', tokenId: 'token-btc', accountId: 'acc-1' },
    { id: 'h2', tokenId: 'token-eth', accountId: 'acc-2' },
  ];
  // h1 gains 10%; h2 doubles. Over both the portfolio would read +55%.
  const fixture = {
    holdings: TWO,
    days: [
      ...days('h1', [
        ['2026-03-01', '1000'],
        ['2026-03-10', '1100'],
      ]),
      ...days('h2', [
        ['2026-03-01', '1000'],
        ['2026-03-10', '2000'],
      ]),
    ],
    txs: [],
  };

  test('a holding that cannot be measured is left out and named, and the rest still has a return', async () => {
    const result = ok(await install({ ...fixture, incompleteHoldings: ['h2'] }).compute(request()));
    expect(result.eligibility).toEqual({ eligible: true, reasons: [] });
    expect(Number(result.twr?.cumulative)).toBeCloseTo(0.1, 12);
    expect(result.startValue).toBe('1000');
    expect(result.endValue).toBe('1100');
    expect(result.subset).toEqual({
      includedHoldings: 1,
      measuredHoldings: 2,
      excluded: [{ reason: 'incomplete-flow-coverage', holdings: 1 }],
      excludedValue: '2000',
      enteredLate: 0,
      unpricedAtZero: 0,
    });
  });

  test('a holding on a loan or card account is left out as debt, not measured (SC-1640)', async () => {
    const result = ok(await install({ ...fixture, debtHoldings: ['h2'] }).compute(request()));
    expect(result.eligibility.eligible).toBe(true);
    expect(result.subset?.excluded).toEqual([{ reason: 'debt-account', holdings: 1 }]);
    expect(Number(result.twr?.cumulative)).toBeCloseTo(0.1, 12);
  });

  test('a stale price on one holding leaves out that holding only', async () => {
    const result = ok(
      await install({
        ...fixture,
        days: fixture.days.map((day) => (day.holdingId === 'h2' ? { ...day, stale: 1 } : day)),
      }).compute(request())
    );
    expect(result.eligibility.eligible).toBe(true);
    expect(result.subset?.excluded).toEqual([{ reason: 'stale-valuation', holdings: 1 }]);
    expect(Number(result.twr?.cumulative)).toBeCloseTo(0.1, 12);
  });

  test('the whole scope measured reports no subset', async () => {
    const result = ok(await install(fixture).compute(request()));
    expect(result.subset).toBeNull();
    expect(Number(result.twr?.cumulative)).toBeCloseTo(0.55, 12);
  });

  test('no holding measurable withholds, with every reason and no subset', async () => {
    const result = ok(await install({ ...fixture, incomplete: true }).compute(request()));
    expect(result.eligibility).toEqual({ eligible: false, reasons: ['incomplete-flow-coverage'] });
    expect(result.twr).toBeNull();
    expect(result.subset).toBeNull();
    expect(result.endValue).toBe('3100');
  });

  test('a queued history rebuild still withholds the whole scope', async () => {
    const result = ok(
      await install({ ...fixture, incompleteHoldings: ['h2'], rebuildPending: true }).compute(
        request()
      )
    );
    expect(result.eligibility.reasons).toEqual(['rebuilding-history']);
    expect(result.twr).toBeNull();
    expect(result.subset).toBeNull();
  });

  test('a year asked of ten days of history is measured over the ten days, not withheld', async () => {
    const result = ok(await install(fixture).compute(request({ window: { kind: '1y' } })));
    expect(result.eligibility.eligible).toBe(true);
    expect(result.effectiveWindow).toEqual({ from: '2026-03-01', to: '2026-03-10' });
    expect(result.requestedWindow.from < '2026-03-01').toBe(true);
  });
});

// SC-1427: 16 IBKR holdings on production were left out because the Flex
// statement starts after the position was bought. The reconciler books the
// older shares as a positive opening at the statement's first day, and the
// engine already treats a holding's first value as money put in (SC-1323).
describe('ReturnsService — a position older than its statement (SC-1427)', () => {
  const TWO = [
    { id: 'h1', tokenId: 'token-btc', accountId: 'acc-1' },
    { id: 'h2', tokenId: 'token-eth', accountId: 'acc-2' },
  ];
  const before = (date: string): DayRow => ({
    date,
    holdingId: 'h2',
    value: '0',
    known: 0,
    total: 0,
    quality: 'unknown',
  });
  const statement = (over: Partial<CoverageFacts> = {}): Partial<CoverageFacts> => ({
    openingBalanceQuantity: '5',
    txSources: ['ibkr-api'],
    firstTxAt: new Date('2026-03-03T09:29:59.999Z'),
    lastReconciledAt: new Date('2026-03-04T00:00:00.000Z'),
    ...over,
  });
  // The reconciler's own row: the shares held before the statement, at its start.
  const opening: TxRow = {
    id: 'tx-opening',
    holdingId: 'h2',
    kind: 'opening_balance',
    quantity: '5',
    priceNative: '100',
    occurredAt: '2026-03-03T09:29:59.999Z',
    tokenId: 'token-eth',
  };
  const flat = (h2Values: Array<[string, string]>) => ({
    holdings: TWO,
    incompleteHoldings: ['h2'],
    days: [
      ...days('h1', [
        ['2026-03-01', '1000'],
        ['2026-03-02', '1000'],
        ['2026-03-03', '1000'],
        ['2026-03-04', '1000'],
      ]),
      before('2026-03-01'),
      before('2026-03-02'),
      ...days('h2', h2Values),
    ],
    txs: [opening],
  });

  // The operator's proof: a flat price and a late opening is 0 gain, over the
  // full window and under its full label.
  test('a flat price with a late opening is 0%, counted, under the full window', async () => {
    const service = install({
      ...flat([
        ['2026-03-03', '500'],
        ['2026-03-04', '500'],
      ]),
      coverage: { h2: statement() },
    });

    const result = ok(await service.compute(request()));
    expect(result.eligibility).toEqual({ eligible: true, reasons: [] });
    expect(Number(result.twr?.cumulative)).toBeCloseTo(0, 12);
    // It arrived as money put in, booked once: the opening row, not also the step.
    expect(result.netExternalFlow).toBe('500');
    expect(result.endValue).toBe('1500');
    expect(result.effectiveWindow?.from).toBe('2026-03-01');
    expect(result.subset).toEqual({
      includedHoldings: 2,
      measuredHoldings: 2,
      excluded: [],
      excludedValue: '0',
      enteredLate: 1,
      unpricedAtZero: 0,
    });
  });

  test('a gain after it enters is a gain', async () => {
    const service = install({
      ...flat([
        ['2026-03-03', '500'],
        ['2026-03-04', '750'],
      ]),
      coverage: { h2: statement() },
    });

    const result = ok(await service.compute(request()));
    expect(Number(result.twr?.cumulative)).toBeCloseTo(250 / 1500, 12);
  });

  // Kraken and Airwallex: money arrived before the ledger's first row.
  test('missing inflows keep it out, and say so', async () => {
    const service = install({
      ...flat([
        ['2026-03-03', '500'],
        ['2026-03-04', '500'],
      ]),
      coverage: { h2: statement({ openingBalanceQuantity: '-5', txSources: ['kraken-api'] }) },
    });

    const result = ok(await service.compute(request()));
    expect(result.subset?.excluded).toEqual([{ reason: 'incomplete-flow-coverage', holdings: 1 }]);
    expect(result.subset?.enteredLate).toBe(0);
  });

  // The operator's manual rule: the ledger starts with the purchase. Nothing
  // was held before, so it is an ordinary arrival and no note is due.
  test('a ledger that starts with the purchase is counted with no note', async () => {
    const service = install({
      ...flat([
        ['2026-03-03', '500'],
        ['2026-03-04', '500'],
      ]),
      txs: [{ ...opening, id: 'tx-buy', kind: 'deposit' }],
      coverage: { h2: statement({ openingBalanceQuantity: null, txSources: [] }) },
    });

    const result = ok(await service.compute(request()));
    expect(result.eligibility.eligible).toBe(true);
    expect(Number(result.twr?.cumulative)).toBeCloseTo(0, 12);
    expect(result.subset).toBeNull();
  });
});

// SC-1428: 58 of mgrin's holdings were airdrops no source prices. With no price
// on any day of the window a token counts at zero — zero value, its flows at
// zero — so it moves no figure and no longer shrinks what the return covers.
// Priced on even one day, it stays `missing-valuation`: then zero is wrong.
describe('ReturnsService — a token nothing ever priced counts at zero (SC-1428)', () => {
  const TWO = [
    { id: 'h1', tokenId: 'token-btc', accountId: 'acc-1' },
    { id: 'h2', tokenId: 'token-air', accountId: 'acc-2' },
  ];
  const unpriced = (date: string): DayRow => ({
    date,
    holdingId: 'h2',
    value: '0',
    known: 0,
    quality: 'unknown',
  });
  const airdrop: TxRow = {
    id: 'tx-air',
    holdingId: 'h2',
    kind: 'airdrop',
    quantity: '1000',
    occurredAt: '2026-03-02T09:00:00.000Z',
    tokenId: 'token-air',
  };
  const h1 = days('h1', [
    ['2026-03-01', '1000'],
    ['2026-03-02', '1050'],
    ['2026-03-03', '1100'],
  ]);

  test('never priced in the window: counted at zero, named, and the figure is h1 alone', async () => {
    const service = install({
      holdings: TWO,
      days: [...h1, unpriced('2026-03-01'), unpriced('2026-03-02'), unpriced('2026-03-03')],
      txs: [airdrop],
    });

    const result = ok(await service.compute(request()));
    expect(result.eligibility).toEqual({ eligible: true, reasons: [] });
    expect(Number(result.twr?.cumulative)).toBeCloseTo(0.1, 12);
    expect(result.subset?.excluded).toEqual([]);
    expect(result.subset?.unpricedAtZero).toBe(1);
    expect(result.coverage.unvaluedFlows).toBe(0);
    expect(result.coverage.daysNotFullyCovered).toBe(0);
  });

  test('priced on one day of the window: stays missing-valuation, not zero', async () => {
    const service = install({
      holdings: TWO,
      days: [
        ...h1,
        unpriced('2026-03-01'),
        { date: '2026-03-02', holdingId: 'h2', value: '20' },
        unpriced('2026-03-03'),
      ],
      txs: [airdrop],
    });

    const result = ok(await service.compute(request()));
    expect(result.subset?.excluded).toEqual([{ reason: 'missing-valuation', holdings: 1 }]);
    expect(result.subset?.unpricedAtZero).toBe(0);
  });

  test('a scope of priced holdings reports no subset at all', async () => {
    const service = install({ holdings: [TWO[0] as (typeof TWO)[number]], days: h1, txs: [] });
    expect(ok(await service.compute(request())).subset).toBeNull();
  });
});

describe('ReturnsService — a ledger that rebuilds below zero is incomplete (SC-1444)', () => {
  // h2 is an ETH wallet whose gas was never recorded: walked back from its
  // earliest balance it goes negative, and the rollup floors it to 0 while
  // its real transfers still book as flows.
  const TWO = [
    { id: 'h1', tokenId: 'token-btc', accountId: 'acc-1' },
    { id: 'h2', tokenId: 'token-eth', accountId: 'acc-2' },
  ];
  const fixture = {
    holdings: TWO,
    days: [
      ...days('h1', [
        ['2026-03-01', '1000'],
        ['2026-03-02', '1050'],
        ['2026-03-03', '1100'],
      ]),
      ...days('h2', [
        ['2026-03-01', '0'],
        ['2026-03-02', '0'],
        ['2026-03-03', '0'],
      ]),
    ],
    txs: [
      {
        id: 'eth-in',
        holdingId: 'h2',
        kind: 'transfer_in',
        quantity: '1',
        priceNative: '400',
        occurredAt: '2026-03-02T15:00:00.000Z',
      },
    ],
  };

  test('it is left out as incomplete history, named, and the rest reads its own return', async () => {
    const result = ok(await install({ ...fixture, negativeRebuild: ['h2'] }).compute(request()));
    expect(result.eligibility.eligible).toBe(true);
    expect(result.subset?.excluded).toEqual([{ reason: 'incomplete-flow-coverage', holdings: 1 }]);
    expect(Number(result.twr?.cumulative)).toBeCloseTo(0.1, 12);
  });

  test('CONTROL: the same data with a reconciling ledger is counted, and the phantom inflow drags the figure', async () => {
    const result = ok(await install(fixture).compute(request()));
    expect(result.subset).toBeNull();
    expect(Number(result.twr?.cumulative)).toBeLessThan(0);
  });
});

// SC-1448: an IBKR position with no trade in the statement window has no
// ledger and no coverage row, only readings that never moved. It was simply
// held, so it counts from its first reading, its value that day booked as
// money put in, exactly like SC-1427's late opening.
describe('ReturnsService — a position simply held, with no ledger (SC-1448)', () => {
  const held = (over: Partial<Fixture> = {}): Fixture => ({
    holdings: [
      { id: 'h1', tokenId: 'token-btc', accountId: 'acc-1' },
      { id: 'h2', tokenId: 'token-eth', accountId: 'acc-2' },
    ],
    noCoverage: ['h2'],
    days: [
      ...days('h1', [
        ['2026-03-01', '1000'],
        ['2026-03-02', '1000'],
        ['2026-03-03', '1000'],
        ['2026-03-04', '1000'],
      ]),
      ...days('h2', [
        ['2026-03-03', '500'],
        ['2026-03-04', '500'],
      ]),
    ],
    txs: [],
    ...over,
  });

  test('a flat price is 0%, and it is counted from its first reading', async () => {
    const service = install(held({ unchangedSince: { h2: '2026-03-03' } }));

    const result = ok(await service.compute(request()));
    expect(result.eligibility).toEqual({ eligible: true, reasons: [] });
    expect(Number(result.twr?.cumulative)).toBeCloseTo(0, 12);
    expect(result.netExternalFlow).toBe('500');
    expect(result.endValue).toBe('1500');
    expect(result.subset).toEqual({
      includedHoldings: 2,
      measuredHoldings: 2,
      excluded: [],
      excludedValue: '0',
      enteredLate: 1,
      unpricedAtZero: 0,
    });
  });

  test('CONTROL: with no unchanged reading it stays out as incomplete', async () => {
    const service = install(held());

    const result = ok(await service.compute(request()));
    expect(result.subset?.excluded).toEqual([{ reason: 'incomplete-flow-coverage', holdings: 1 }]);
    expect(result.subset?.includedHoldings).toBe(1);
  });
});

// SC-1427: 20 of mgrin's holdings were left out for insufficient history, all
// for interpolated days. Two of them for ONE day in a year. A run of up to
// three consecutive interpolated days is tolerated; a longer run still
// excludes, because then the line between two observations is the data.
describe('ReturnsService — a short interpolated run is tolerated (SC-1427)', () => {
  const TWO = [
    { id: 'h1', tokenId: 'token-btc', accountId: 'acc-1' },
    { id: 'h2', tokenId: 'token-eth', accountId: 'acc-2' },
  ];
  const DATES = [
    '2026-03-01',
    '2026-03-02',
    '2026-03-03',
    '2026-03-04',
    '2026-03-05',
    '2026-03-06',
    '2026-03-07',
    '2026-03-08',
  ];
  const withRun = (interpolated: readonly string[]) => ({
    holdings: TWO,
    days: [
      ...days(
        'h1',
        DATES.map((d) => [d, '1000'] as [string, string])
      ),
      ...DATES.map(
        (date): DayRow => ({
          date,
          holdingId: 'h2',
          value: '500',
          interpolated: interpolated.includes(date) ? 1 : 0,
        })
      ),
    ],
    txs: [],
  });
  const excluded = async (interpolated: readonly string[]) =>
    ok(await install(withRun(interpolated)).compute(request())).subset?.excluded ?? [];

  test('three consecutive interpolated days: counted', async () => {
    expect(await excluded(['2026-03-03', '2026-03-04', '2026-03-05'])).toEqual([]);
  });

  test('four consecutive interpolated days: insufficient-history', async () => {
    expect(await excluded(['2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06'])).toEqual([
      { reason: 'insufficient-history', holdings: 1 },
    ]);
  });

  test('two separate short runs are two runs, not one: counted', async () => {
    expect(await excluded(['2026-03-02', '2026-03-03', '2026-03-06', '2026-03-07'])).toEqual([]);
  });

  test('one day before the first record still excludes: the tolerance is for interpolation only', async () => {
    const fixture = withRun([]);
    const service = install({
      ...fixture,
      days: fixture.days.map((d) =>
        d.holdingId === 'h2' && d.date === '2026-03-02' ? { ...d, beforeRecords: 1 } : d
      ),
    });
    expect(ok(await service.compute(request())).subset?.excluded).toEqual([
      { reason: 'insufficient-history', holdings: 1 },
    ]);
  });
});

// SC-1541: the engine calls a daily crypto price stale after 48 hours, where
// the old resolver allowed 45 days. SOMM's provider skipped eight days in April
// 2026 and resumed, and that closed gap took the holding out of every window.
describe('ReturnsService — a closed price gap is tolerated (SC-1541)', () => {
  const TWO = [
    { id: 'h1', tokenId: 'token-btc', accountId: 'acc-1' },
    { id: 'h2', tokenId: 'token-eth', accountId: 'acc-2' },
  ];
  // Every run ends on NOW's day, so the window reaches all of it.
  const datesEnding = (count: number) =>
    Array.from({ length: count }, (_, i) =>
      new Date(Date.UTC(2026, 2, 10 - (count - 1) + i)).toISOString().slice(0, 10)
    );
  const withGap = (dates: readonly string[], gap: readonly string[], gapDay: Partial<DayRow>) => ({
    holdings: TWO,
    days: [
      ...days(
        'h1',
        dates.map((d) => [d, '1000'] as [string, string])
      ),
      ...dates.map(
        (date): DayRow => ({
          date,
          holdingId: 'h2',
          value: '500',
          ...(gap.includes(date) ? gapDay : {}),
        })
      ),
    ],
    txs: [],
  });
  const STALE_DAY: Partial<DayRow> = { stale: 1, quality: 'partial' };
  const excluded = async (
    dates: readonly string[],
    gap: readonly string[],
    gapDay: Partial<DayRow> = STALE_DAY
  ) =>
    [
      ...(ok(await install(withGap(dates, gap, gapDay)).compute(request())).subset?.excluded ?? []),
    ].sort((a, b) => a.reason.localeCompare(b.reason));
  const TEN = datesEnding(10);
  const BOTH = [
    { reason: 'missing-valuation', holdings: 1 },
    { reason: 'stale-valuation', holdings: 1 },
  ];

  test('a gap the feed closed inside the window: counted', async () => {
    expect(await excluded(TEN, TEN.slice(2, 8))).toEqual([]);
  });

  test('a gap still open on the window’s last day excludes', async () => {
    expect(await excluded(TEN, TEN.slice(7))).toEqual(BOTH);
  });

  test('a gap open on the window’s first day excludes', async () => {
    expect(await excluded(TEN, TEN.slice(0, 2))).toEqual(BOTH);
  });

  test('a closed gap of 45 days is counted; 46 days excludes', async () => {
    const fifty = datesEnding(50);
    expect(await excluded(fifty, fifty.slice(2, 47))).toEqual([]);
    expect(await excluded(fifty, fifty.slice(2, 48))).toEqual(BOTH);
  });

  test('a gap day that also lost its value still excludes as missing-valuation', async () => {
    expect(
      await excluded(TEN, TEN.slice(2, 4), { stale: 1, quality: 'estimated', known: 0 })
    ).toEqual(BOTH);
  });
});

// An All window that opened on a few hundred pounds of tokens held for years
// before the bulk of the money arrived let those years decide the figure
// (SC-1439).
describe('ReturnsService — a window starts where its capital is material (SC-1439)', () => {
  test('a tiny volatile start before the bulk arrives is not measured', async () => {
    const service = install({
      holdings: ONE_HOLDING,
      days: days('h1', [
        ['2026-03-01', '100'],
        ['2026-03-02', '60'],
        ['2026-03-03', '78'],
        ['2026-03-04', '10078'],
        ['2026-03-05', '10100'],
      ]),
      txs: [
        {
          id: 'tx-1',
          holdingId: 'h1',
          kind: 'deposit',
          quantity: '100',
          priceNative: '100',
          occurredAt: '2026-03-04T09:00:00.000Z',
        },
      ],
    });

    const result = ok(await service.compute(request()));
    expect(result.effectiveWindow).toEqual({ from: '2026-03-04', to: '2026-03-05' });
    expect(result.netExternalFlow).toBe('0');
    expect(Number(result.twr?.cumulative)).toBeCloseTo(10100 / 10078 - 1, 12);
  });

  test('CONTROL: the same start with no money added later is measured whole', async () => {
    const service = install({
      holdings: ONE_HOLDING,
      days: days('h1', [
        ['2026-03-01', '100'],
        ['2026-03-02', '60'],
        ['2026-03-03', '78'],
      ]),
      txs: [],
    });

    const result = ok(await service.compute(request()));
    expect(result.effectiveWindow?.from).toBe('2026-03-01');
    expect(Number(result.twr?.cumulative)).toBeCloseTo(-0.22, 12);
  });
});

describe('ReturnsService — money in transit (SC-1675)', () => {
  // 500 leaves h1 on 03-02 for h2, a provider-fed holding; the provider shows
  // it arriving on 03-04. The person owns 1000 throughout.
  const TRANSIT_FIXTURE = {
    holdings: [
      { id: 'h1', tokenId: BASE, accountId: 'acc-1' },
      { id: 'h2', tokenId: BASE, accountId: 'acc-2' },
    ],
    days: [
      ...days('h1', [
        ['2026-03-01', '1000'],
        ['2026-03-02', '500'],
        ['2026-03-03', '500'],
        ['2026-03-04', '500'],
      ]),
      ...days('h2', [
        ['2026-03-01', '0'],
        ['2026-03-02', '0'],
        ['2026-03-03', '0'],
        ['2026-03-04', '500'],
      ]),
    ],
    transitDays: [
      { date: '2026-03-02', holdingId: 'h2', value: '500' },
      { date: '2026-03-03', holdingId: 'h2', value: '500' },
    ],
    txs: [
      {
        id: 'tx-out',
        holdingId: 'h1',
        kind: 'withdraw',
        quantity: '-500',
        occurredAt: '2026-03-02T09:00:00.000Z',
      },
      {
        id: 'tx-arr',
        holdingId: 'h2',
        kind: 'transfer_in',
        quantity: '500',
        occurredAt: '2026-03-04T09:00:00.000Z',
      },
    ],
    transits: [
      {
        outflowId: 'tx-out',
        sourceHoldingId: 'h1',
        destinationHoldingId: 'h2',
        destinationAccountId: 'acc-2',
        tokenId: BASE,
        transit: {
          sent: '500',
          sentAt: new Date('2026-03-02T09:00:00.000Z'),
          arrivalId: 'tx-arr',
          arrived: true,
        },
        arrival: { quantity: '500', at: new Date('2026-03-04T09:00:00.000Z') },
        askAgainAt: null,
      },
    ],
  };

  test('a transfer that travels for two days is no return and no flow', async () => {
    const service = install(TRANSIT_FIXTURE);
    const result = ok(await service.compute(request()));
    expect(result.series.map((p) => p.value)).toEqual(['1000', '1000', '1000', '1000']);
    expect(result.netExternalFlow).toBe('0');
    expect(Number(result.twr?.cumulative)).toBe(0);
  });

  test('a window that ends while the money travels still reads no return', async () => {
    const service = install(TRANSIT_FIXTURE);
    const result = ok(
      await service.compute(
        request({
          window: {
            kind: 'custom',
            from: new Date('2026-03-01T00:00:00.000Z'),
            to: new Date('2026-03-03T00:00:00.000Z'),
          },
        })
      )
    );
    expect(result.endValue).toBe('1000');
    expect(result.netExternalFlow).toBe('0');
    expect(Number(result.twr?.cumulative)).toBe(0);
  });

  test('CONTROL: the destination account sees the arrival cross its boundary when it lands', async () => {
    const service = install(TRANSIT_FIXTURE);
    const result = ok(await service.compute(request({ scope: { kind: 'account', id: 'acc-2' } })));
    expect(result.netExternalFlow).toBe('500');
  });
});

describe('ReturnsService — the windows of one Home load share their loads (SC-1671)', () => {
  const FIXTURE = {
    holdings: ONE_HOLDING,
    days: [
      { date: '2025-02-01', holdingId: 'h1', value: '700' },
      { date: '2025-12-31', holdingId: 'h1', value: '1000' },
      { date: '2026-03-10', holdingId: 'h1', value: '1300' },
    ],
    txs: [],
  };
  const KINDS = ['all', '1y', 'ytd'] as const;

  function withDriftRecorder(fixture: Fixture) {
    install(fixture);
    const driftMemos: unknown[] = [];
    Container.set(DriftLedgerService, {
      forHoldings: async (_userId: string, _tokens: unknown, opts: { shared?: unknown }) => {
        driftMemos.push(opts.shared);
        return new Map();
      },
    } as unknown as DriftLedgerService);
    Container.set(ExternalFlowService, new ExternalFlowService());
    const service = new ReturnsService();
    Container.set(ReturnsService, service);
    return { service, driftMemos };
  }

  test('three windows at once resolve currencies once and hand the drift read one memo', async () => {
    const { service, driftMemos } = withDriftRecorder(FIXTURE);
    const resolve = spyOn(Container.get(AssetCurrencyService), 'resolve');
    try {
      const shared = new ReturnsSharedLoads();
      await Promise.all(
        KINDS.map((kind) => service.compute(request({ window: { kind } }), { shared }))
      );
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(driftMemos.length).toBe(3);
      expect(new Set(driftMemos)).toEqual(new Set([shared.driftByHolding]));
    } finally {
      resolve.mockRestore();
    }
  });

  test('control: without shared loads each window resolves its own currencies', async () => {
    const { service, driftMemos } = withDriftRecorder(FIXTURE);
    const resolve = spyOn(Container.get(AssetCurrencyService), 'resolve');
    try {
      await Promise.all(KINDS.map((kind) => service.compute(request({ window: { kind } }))));
      expect(resolve).toHaveBeenCalledTimes(3);
      expect(driftMemos).toEqual([undefined, undefined, undefined]);
    } finally {
      resolve.mockRestore();
    }
  });

  test('a failed currency load is dropped at once, so a later call loads again', async () => {
    const { service } = withDriftRecorder(FIXTURE);
    const currencies = Container.get(AssetCurrencyService);
    const real = currencies.resolve.bind(currencies);
    let calls = 0;
    const resolve = spyOn(currencies, 'resolve').mockImplementation(async (...args) => {
      calls += 1;
      if (calls === 1) throw new Error('token read failed');
      return real(...args);
    });
    try {
      const shared = new ReturnsSharedLoads();
      await expect(
        service.compute(request({ window: { kind: 'all' } }), { shared })
      ).rejects.toThrow('token read failed');
      const outcome = await service.compute(request({ window: { kind: 'all' } }), { shared });
      expect(outcome.status).toBe('ok');
      expect(resolve).toHaveBeenCalledTimes(2);
    } finally {
      resolve.mockRestore();
    }
  });

  test('each window returns what it returns alone', async () => {
    const { service } = withDriftRecorder(FIXTURE);
    const shared = new ReturnsSharedLoads();
    const together = await Promise.all(
      KINDS.map((kind) => service.compute(request({ window: { kind } }), { shared }))
    );
    const alone = [];
    for (const kind of KINDS) alone.push(await service.compute(request({ window: { kind } })));
    expect(together).toEqual(alone);
    expect(together.map((outcome) => ok(outcome).requestedWindow.kind)).toEqual([...KINDS]);
  });
});
