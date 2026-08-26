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
 * SC-249. `BalanceAtTimeService` decides how each past-date balance was
 * anchored and when, "so callers can judge confidence" per its own comment.
 * `observation-before` is the weak one: nothing at or after the requested date
 * existed, so the quantity was extrapolated FORWARD from older data.
 *
 * **These tests assert the provenance, never the balance.** The defect was
 * that correct numbers arrived with no way to rank them, so every assertion
 * about a total or a coverage letter passes identically against the broken
 * code — the totals were never wrong. What was missing is a count and a
 * timestamp, and only asserting those fails before the fix.
 *
 * The discriminating case is `oldestAnchorAt`. Production holds both extremes
 ***REMOVED***
 ***REMOVED***
 * anchor it saw, or the most recent one, would satisfy every other assertion
 * here while answering the only question a reader has.
 */

const USD = 'token-USD';
const AT = new Date('2026-08-15T12:00:00Z');

// The two production gaps, as anchors behind `AT`.
const SECONDS_BACK = new Date('2026-08-15T11:59:06Z'); // 54s
const DAYS_BACK = new Date('2026-06-05T12:00:00Z'); // 71d

type Anchor = 'holdings' | 'observation-after' | 'observation-before';

interface Fixture {
  holdingId: string;
  tokenId: string;
  anchor: Anchor;
  anchorAt: Date;
  priceStale?: boolean;
}

function makeService(holdings: Fixture[]): PortfolioValuationAtTimeService {
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
      if (!h) throw new Error(`no fixture for ${holdingId}`);
      return { balance: new Decimal(10), anchor: h.anchor, anchorAt: h.anchorAt, txApplied: 0 };
    },
  } as unknown as BalanceAtTimeService);
  Container.set(PriceGraphService, {
    convert: async (amount: Decimal, fromTokenId: string) => {
      const h = holdings.find((x) => x.tokenId === fromTokenId);
      return {
        amount: amount.mul(2),
        rate: new Decimal(2),
        effectiveAt: AT,
        path: 'direct',
        stale: h?.priceStale ?? false,
      };
    },
  } as unknown as PriceGraphService);
  Container.set(UserRepository, {} as unknown as UserRepository);
  Container.set(TokenRepository, {
    findNeverPricedInCooldownTokenIds: async () => new Set<string>(),
  } as unknown as TokenRepository);
  const instance = new PortfolioValuationAtTimeService();
  Container.set(PortfolioValuationAtTimeService, instance);
  return instance;
}

describe('anchor provenance reaches the result', () => {
  test('oldestAnchorAt is the OLDEST backward anchor, not the first seen', async () => {
    // Ordered so first-seen (54s) and oldest (71d) differ. An implementation
    // that took whichever it met first would return SECONDS_BACK and read as
    // "anchored a minute ago" on a portfolio anchored ten weeks ago.
    const svc = makeService([
      {
        holdingId: 'h-recent',
        tokenId: 't1',
        anchor: 'observation-before',
        anchorAt: SECONDS_BACK,
      },
      { holdingId: 'h-old', tokenId: 't2', anchor: 'observation-before', anchorAt: DAYS_BACK },
    ]);

    const r = await svc.getPortfolioValue('u', AT, USD, { tx: undefined });

    expect(r.holdingsStaleAnchored).toBe(2);
    expect(r.oldestAnchorAt?.toISOString()).toBe(DAYS_BACK.toISOString());
  });

  test('only observation-before counts; a forward anchor is not a weak one', async () => {
    // `holdings` and `observation-after` both anchor at or after the date and
    // walk BACKWARD to it, which is the strong direction. Counting them would
    // mark every ordinary day as degraded and make the number meaningless.
    const svc = makeService([
      { holdingId: 'h-cur', tokenId: 't1', anchor: 'holdings', anchorAt: AT },
      { holdingId: 'h-aft', tokenId: 't2', anchor: 'observation-after', anchorAt: AT },
      { holdingId: 'h-bef', tokenId: 't3', anchor: 'observation-before', anchorAt: DAYS_BACK },
    ]);

    const r = await svc.getPortfolioValue('u', AT, USD, { tx: undefined });

    expect(r.holdingsStaleAnchored).toBe(1);
    expect(r.oldestAnchorAt?.toISOString()).toBe(DAYS_BACK.toISOString());
  });

  test('none backward-anchored reports a counted zero, not null', async () => {
    // `0` and "not recorded" are different claims and the column that stores
    // this is nullable so they stay different. The service always counts, so
    // it must always produce a number.
    const svc = makeService([
      { holdingId: 'h-cur', tokenId: 't1', anchor: 'holdings', anchorAt: AT },
    ]);

    const r = await svc.getPortfolioValue('u', AT, USD, { tx: undefined });

    expect(r.holdingsStaleAnchored).toBe(0);
    expect(r.oldestAnchorAt).toBeNull();
    expect(r.coverageQuality).toBe('full');
  });

  test('a stale anchor and a stale price are counted apart', async () => {
    // Both land the day on 'partial'. Before SC-249 that single letter was
    // the whole signal, so the two were indistinguishable — and their
    // remedies are not: a stale price wants a quote, a stale anchor wants an
    // observation.
    const svc = makeService([
      { holdingId: 'h-price', tokenId: 't1', anchor: 'holdings', anchorAt: AT, priceStale: true },
      { holdingId: 'h-anch', tokenId: 't2', anchor: 'observation-before', anchorAt: DAYS_BACK },
    ]);

    const r = await svc.getPortfolioValue('u', AT, USD, { tx: undefined });

    expect(r.coverageQuality).toBe('partial');
    expect(r.holdingsStalePriced).toBe(1);
    expect(r.holdingsStaleAnchored).toBe(1);
  });

  test('every per-holding row carries its own anchorAt', async () => {
    // The scope-level number says the worst case; the per-holding field says
    // WHICH holding, which is what a detail page needs to explain itself.
    const svc = makeService([
      {
        holdingId: 'h-recent',
        tokenId: 't1',
        anchor: 'observation-before',
        anchorAt: SECONDS_BACK,
      },
      { holdingId: 'h-old', tokenId: 't2', anchor: 'observation-before', anchorAt: DAYS_BACK },
    ]);

    const r = await svc.getPortfolioValue('u', AT, USD, { tx: undefined });

    const recent = r.perHolding.find((p) => p.holdingId === 'h-recent');
    const old = r.perHolding.find((p) => p.holdingId === 'h-old');
    expect(recent?.anchorAt?.toISOString()).toBe(SECONDS_BACK.toISOString());
    expect(old?.anchorAt?.toISOString()).toBe(DAYS_BACK.toISOString());
    expect(recent?.anchorSource).toBe('observation-before');
  });
});
