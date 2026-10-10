process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { describe, expect, test } from 'bun:test';
import Decimal from 'decimal.js';
import { Container } from 'typedi';
import { AccountRepository } from '../../../src/repositories/AccountRepository';
import { HoldingRepository } from '../../../src/repositories/HoldingRepository';
import { TokenRepository } from '../../../src/repositories/TokenRepository';
import { UserRepository } from '../../../src/repositories/UserRepository';
import { InTransitService } from '../../../src/services/portfolio/InTransitService';
import { PortfolioValuationAtTimeService } from '../../../src/services/portfolio/PortfolioValuationAtTimeService';
import { BalanceAtTimeService } from '../../../src/services/pricing/BalanceAtTimeService';
import { PriceReader } from '../../../src/services/pricing/PriceReader';
import { restoreContainerAfterAll } from '../../../test/helpers/container';
import { priceReaderStub } from '../../../test/helpers/price-series';

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
 * Since A5 PR-2 the engine answers every past balance, and a forward walk from
 * an earlier reading is its ordinary method rather than a weak one, so the
 * stale-anchor count is always 0 and only the per-holding provenance remains
 * (D-14). The paragraph below describes the old walk.
 *
 * The discriminating case was `oldestAnchorAt`. Production holds both extremes
 * in one portfolio — a holding anchored seconds back and another months back
 * (SC-245) — and an implementation that recorded the FIRST backward
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
      holdings.map((h) => ({
        id: h.holdingId,
        accountId: 'acc',
        tokenId: h.tokenId,
        isActive: true,
      })),
  } as unknown as HoldingRepository);
  Container.set(AccountRepository, {
    findByUser: async () => [{ id: 'acc', institutionId: 'inst' }],
  } as unknown as AccountRepository);
  Container.set(BalanceAtTimeService, {
    getBalance: async (holdingId: string) => {
      const h = holdings.find((x) => x.holdingId === holdingId);
      if (!h) throw new Error(`no fixture for ${holdingId}`);
      return { balance: new Decimal(10), anchor: h.anchor, anchorAt: h.anchorAt };
    },
  } as unknown as BalanceAtTimeService);
  Container.set(
    PriceReader,
    priceReaderStub((amount: Decimal, fromTokenId: string) => {
      const h = holdings.find((x) => x.tokenId === fromTokenId);
      return {
        amount: amount.mul(2),
        rate: new Decimal(2),
        effectiveAt: AT,
        path: 'direct',
        stale: h?.priceStale ?? false,
      };
    })
  );
  Container.set(UserRepository, {} as unknown as UserRepository);
  Container.set(TokenRepository, {
    findNeverPricedInCooldownTokenIds: async () => new Set<string>(),
  } as unknown as TokenRepository);
  // These portfolios hold no transfer in transit; the real read needs uuid ids.
  Container.set(InTransitService, { amountsAt: async () => [] } as unknown as InTransitService);
  const instance = new PortfolioValuationAtTimeService();
  Container.set(PortfolioValuationAtTimeService, instance);
  return instance;
}

describe('anchor provenance reaches the result', () => {
  test('an anchor before the date is not a stale anchor (A5 D-14)', async () => {
    // The old walk reached `observation-before` only when nothing at or after
    // the date existed, so it was extrapolation. The engine walks FORWARD from
    // the latest reading on every ordinary day, so counting it would mark
    // every day as degraded. A balance's staleness is A4's to report.
    const svc = makeService([
      {
        holdingId: 'h-recent',
        tokenId: 't1',
        anchor: 'observation-before',
        anchorAt: SECONDS_BACK,
      },
      { holdingId: 'h-old', tokenId: 't2', anchor: 'observation-before', anchorAt: DAYS_BACK },
      { holdingId: 'h-aft', tokenId: 't3', anchor: 'observation-after', anchorAt: AT },
    ]);

    const r = await svc.getPortfolioValue('u', AT, USD, { tx: undefined });

    expect(r.holdingsStaleAnchored).toBe(0);
    expect(r.oldestAnchorAt).toBeNull();
    expect(r.coverageQuality).toBe('full');
  });

  test('none backward-anchored reports a counted zero, not null', async () => {
    // `0` and "not recorded" are different claims and the column that stores
    // this is nullable so they stay different. The service always counts, so
    // it must always produce a number.
    const svc = makeService([
      { holdingId: 'h-cur', tokenId: 't1', anchor: 'observation-after', anchorAt: AT },
    ]);

    const r = await svc.getPortfolioValue('u', AT, USD, { tx: undefined });

    expect(r.holdingsStaleAnchored).toBe(0);
    expect(r.oldestAnchorAt).toBeNull();
    expect(r.coverageQuality).toBe('full');
  });

  test('a stale price still lands the day on partial; an anchor before it does not', async () => {
    // A stale price wants a quote, and it is still the one signal that
    // degrades the day (SC-249). The before-anchor beside it adds nothing.
    const svc = makeService([
      {
        holdingId: 'h-price',
        tokenId: 't1',
        anchor: 'observation-after',
        anchorAt: AT,
        priceStale: true,
      },
      { holdingId: 'h-anch', tokenId: 't2', anchor: 'observation-before', anchorAt: DAYS_BACK },
    ]);

    const r = await svc.getPortfolioValue('u', AT, USD, { tx: undefined });

    expect(r.coverageQuality).toBe('partial');
    expect(r.holdingsStalePriced).toBe(1);
    expect(r.holdingsStaleAnchored).toBe(0);
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
