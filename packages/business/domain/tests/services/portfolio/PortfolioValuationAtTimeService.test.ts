process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { describe, expect, test } from 'bun:test';
import Decimal from 'decimal.js';
import { Container } from 'typedi';
import { AccountRepository } from '../../../src/repositories/AccountRepository';
import { HoldingRepository } from '../../../src/repositories/HoldingRepository';
import { TokenRepository } from '../../../src/repositories/TokenRepository';
import { UserRepository } from '../../../src/repositories/UserRepository';
import { PortfolioValuationAtTimeService } from '../../../src/services/portfolio/PortfolioValuationAtTimeService';
import { BalanceAtTimeService } from '../../../src/services/pricing/BalanceAtTimeService';
import { PriceGraphService } from '../../../src/services/pricing/PriceGraphService';
import { restoreContainerAfterAll } from '../../../test/helpers/container';

// Container stubs are process-global; put back whatever this file changes
// so no later test file resolves them (SC-448).
restoreContainerAfterAll();

/**
 * The coverage denominator (SC-146).
 *
 ***REMOVED***
 ***REMOVED***
 ***REMOVED***
 * assets the user actually owns were priced. `USDT` is in the fixture
 * carrying the same 0.3 scam score as the spam, because it is on the real
 * account and because any fix that reads that score instead of pricing
 * behaviour deletes Tether from the portfolio.
 */

const USD = 'token-USD';
const AT = new Date('2026-08-14T12:00:00Z');

interface Fixture {
  holdingId: string;
  tokenId: string;
  /** null → the price graph cannot value it at `at`. */
  price: number | null;
  balance?: number;
  /** `at` precedes every record we hold for this holding — see SC-252. */
  beforeRecords?: boolean;
}

function makeService(
  holdings: Fixture[],
  unpriceableTokenIds: string[]
): PortfolioValuationAtTimeService {
  Container.set(HoldingRepository, {
    findByUser: async () =>
      holdings.map((h) => ({ id: h.holdingId, accountId: 'acc', tokenId: h.tokenId })),
  } as unknown as HoldingRepository);
  Container.set(AccountRepository, {
    findByUser: async () => [{ id: 'acc', institutionId: 'inst' }],
  } as unknown as AccountRepository);
  Container.set(BalanceAtTimeService, {
    getBalance: async (holdingId: string) => {
      const h = holdings.find((x) => x.holdingId === holdingId);
      return {
        balance: new Decimal(h?.balance ?? 10),
        anchor: 'holdings' as const,
        anchorAt: AT,
        txApplied: 0,
        beforeRecords: h?.beforeRecords ?? false,
      };
    },
  } as unknown as BalanceAtTimeService);
  Container.set(PriceGraphService, {
    convert: async (amount: Decimal, fromTokenId: string) => {
      const h = holdings.find((x) => x.tokenId === fromTokenId);
      if (!h || h.price === null) return null;
      return {
        amount: amount.mul(h.price),
        rate: new Decimal(h.price),
        effectiveAt: AT,
        path: 'direct',
        stale: false,
      };
    },
  } as unknown as PriceGraphService);
  Container.set(UserRepository, {} as unknown as UserRepository);
  Container.set(TokenRepository, {
    findNeverPricedInCooldownTokenIds: async () => new Set(unpriceableTokenIds),
  } as unknown as TokenRepository);
  const instance = new PortfolioValuationAtTimeService();
  Container.set(PortfolioValuationAtTimeService, instance);
  return instance;
}

// The shape of the real account, scaled down: three assets that price,
// one stablecoin that prices *and* carries the spam's scam score, two
// airdrop tokens nothing has ever quoted.
const REAL_SHAPE: Fixture[] = [
  { holdingId: 'h-btc', tokenId: 't-btc', price: 60000 },
  { holdingId: 'h-eth', tokenId: 't-eth', price: 3000 },
  { holdingId: 'h-aapl', tokenId: 't-aapl', price: 200 },
  { holdingId: 'h-usdt', tokenId: 't-usdt', price: 1 }, // is_scam_probability 0.3
  { holdingId: 'h-spam1', tokenId: 't-spam1', price: null },
  { holdingId: 'h-spam2', tokenId: 't-spam2', price: null },
];

describe('PortfolioValuationAtTimeService — unpriceable holdings', () => {
  test('dust leaves the denominator; a fully-priced portfolio reads as full', async () => {
    const svc = makeService(REAL_SHAPE, ['t-spam1', 't-spam2']);

    const r = await svc.getPortfolioValue('u', AT, USD);

    expect(r.holdingsTotal).toBe(6); // every row is still there
    expect(r.holdingsUnpriceable).toBe(2);
    expect(r.holdingsWithKnownValue).toBe(4);
    // 4 / (6 − 2) = 1.0, not 4 / 6 = 0.67 → 'estimated'
    expect(r.coverageQuality).toBe('full');
  });

  test('a priced token keeps its place in the denominator whatever its scam score', async () => {
    // Exactly the fix that must not ship: treating the 0.3 bucket as dust.
    // USDT prices, so the behavioural predicate never nominates it, and it
    // stays in both the total and the value.
    const svc = makeService(REAL_SHAPE, ['t-spam1', 't-spam2']);

    const r = await svc.getPortfolioValue('u', AT, USD);

    const usdt = r.perHolding.find((p) => p.holdingId === 'h-usdt');
    expect(usdt?.unpriceable).toBe(false);
    expect(usdt?.valueInBase?.toString()).toBe('10');
    expect(r.totalValueInBase.toString()).toBe('632010'); // 600000 + 30000 + 2000 + 10
  });

  test('an unpriced holding we might yet price still counts against coverage', async () => {
    // Nothing is in cooldown: this is a real gap in our pricing, and the
    // chart must keep saying so rather than quietly excusing it.
    const svc = makeService(REAL_SHAPE, []);

    const r = await svc.getPortfolioValue('u', AT, USD);

    expect(r.holdingsUnpriceable).toBe(0);
    expect(r.holdingsWithKnownValue).toBe(4);
    expect(r.coverageQuality).toBe('estimated'); // 4/6 = 0.67
  });

  test('the excluded holdings are still reported, flagged rather than dropped', async () => {
    const svc = makeService(REAL_SHAPE, ['t-spam1', 't-spam2']);

    const r = await svc.getPortfolioValue('u', AT, USD);

    expect(r.perHolding).toHaveLength(6);
    const flagged = r.perHolding.filter((p) => p.unpriceable).map((p) => p.holdingId);
    expect(flagged.sort()).toEqual(['h-spam1', 'h-spam2']);
  });

  test('a scope holding nothing but dust reports unknown, not full', async () => {
    // 0 known out of 0 priceable is not a measurement, and calling it
    // 'full' would let the chart draw a confident zero.
    const svc = makeService(
      [
        { holdingId: 'h-spam1', tokenId: 't-spam1', price: null },
        { holdingId: 'h-spam2', tokenId: 't-spam2', price: null },
      ],
      ['t-spam1', 't-spam2']
    );

    const r = await svc.getPortfolioValue('u', AT, USD);

    expect(r.holdingsTotal).toBe(2);
    expect(r.holdingsUnpriceable).toBe(2);
    expect(r.coverageQuality).toBe('unknown');
  });

  test('a zero balance of an unpriceable token is a measurement, not dust', async () => {
    // Zero × anything is zero, so the zero-balance short-circuit values it
    // and counts it as known. It must therefore stay in the denominator —
    // otherwise `holdingsWithKnownValue` could exceed the priceable total.
    const svc = makeService(
      [
        { holdingId: 'h-btc', tokenId: 't-btc', price: 60000 },
        { holdingId: 'h-spam1', tokenId: 't-spam1', price: null, balance: 0 },
      ],
      ['t-spam1']
    );

    const r = await svc.getPortfolioValue('u', AT, USD);

    expect(r.holdingsUnpriceable).toBe(0);
    expect(r.holdingsWithKnownValue).toBe(2);
    expect(r.holdingsWithKnownValue).toBeLessThanOrEqual(r.holdingsTotal - r.holdingsUnpriceable);
  });
});

/**
 * Balances that predate every record we hold (SC-252).
 *
 * Production wrote `total_value = 586.94, coverage_quality = 'full'` for
 * 2025-06-21 on a holding whose first transaction is 2026-06-22 — a
 * confident assertion about a period more than a year before the holding
 * existed. The value is left alone here on purpose: propagating a balance
 * backward is the history chart's intended behaviour, and the ticket's
 * complaint was never that a number was drawn, it was that the number was
 * stamped 'full'. So the number survives and the confidence does not.
 */
describe('PortfolioValuationAtTimeService — balances predating our records', () => {
  const AIRWALLEX: Fixture[] = [
    { holdingId: 'h-awx', tokenId: 't-usd', price: 1, balance: 586.94, beforeRecords: true },
  ];

  test('a pre-existence date is never stamped full', async () => {
    const svc = makeService(AIRWALLEX, []);

    const r = await svc.getPortfolioValue('u', AT, USD);

    expect(r.coverageQuality).not.toBe('full');
    expect(r.coverageQuality).toBe('partial');
  });

  test('the value is kept, so the chart keeps its line', async () => {
    const svc = makeService(AIRWALLEX, []);

    const r = await svc.getPortfolioValue('u', AT, USD);

    expect(r.totalValueInBase.toString()).toBe('586.94');
    expect(r.holdingsWithKnownValue).toBe(1);
  });

  test('the count travels with the figure', async () => {
    const svc = makeService(
      [...AIRWALLEX, { holdingId: 'h-btc', tokenId: 't-btc', price: 60000 }],
      []
    );

    const r = await svc.getPortfolioValue('u', AT, USD);

    expect(r.holdingsBeforeRecords).toBe(1);
    expect(r.perHolding.find((p) => p.holdingId === 'h-awx')?.balanceBeforeRecords).toBe(true);
    expect(r.perHolding.find((p) => p.holdingId === 'h-btc')?.balanceBeforeRecords).toBe(false);
  });

  test('a portfolio inside its own records still reads full', async () => {
    const svc = makeService([{ holdingId: 'h-btc', tokenId: 't-btc', price: 60000 }], []);

    const r = await svc.getPortfolioValue('u', AT, USD);

    expect(r.holdingsBeforeRecords).toBe(0);
    expect(r.coverageQuality).toBe('full');
  });
});
