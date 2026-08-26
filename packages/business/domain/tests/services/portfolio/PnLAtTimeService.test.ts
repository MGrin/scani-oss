process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { describe, expect, test } from 'bun:test';
import type { HoldingTransaction } from '@scani/db/schema';
import Decimal from 'decimal.js';
import { Container } from 'typedi';
import { HoldingCoverageRepository } from '../../../src/repositories/HoldingCoverageRepository';
import { HoldingTransactionRepository } from '../../../src/repositories/HoldingTransactionRepository';
import { PnLAtTimeService } from '../../../src/services/portfolio/PnLAtTimeService';
import { PortfolioValuationAtTimeService } from '../../../src/services/portfolio/PortfolioValuationAtTimeService';
import type { BalanceAtTimeCaches } from '../../../src/services/pricing/BalanceAtTimeService';
import {
  type CostBasisAtTime,
  CostBasisService,
} from '../../../src/services/pricing/CostBasisService';
import { restoreContainerAfterAll } from '../../../test/helpers/container';

// Container stubs are process-global; put back whatever this file changes
// so no later test file resolves them (SC-448).
restoreContainerAfterAll();

const USD = 'token-USD';

interface ValuationHolding {
  holdingId: string;
  tokenId: string;
  valueInBase: Decimal | null;
  unpriceable?: boolean;
  priceStale?: boolean;
  balanceBeforeRecords?: boolean;
}

function makeValuationStub(holdings: ValuationHolding[]): PortfolioValuationAtTimeService {
  const total = holdings.reduce(
    (s, h) => (h.valueInBase ? s.add(h.valueInBase) : s),
    new Decimal(0)
  );
  return {
    getPortfolioValue: async () => ({
      userId: 'u',
      at: new Date(),
      baseCurrencyId: USD,
      totalValueInBase: total,
      coverageQuality: 'full',
      holdingsWithKnownValue: holdings.length,
      holdingsTotal: holdings.length,
      holdingsUnpriceable: holdings.filter((h) => h.unpriceable).length,
      holdingsStalePriced: holdings.filter((h) => h.priceStale).length,
      holdingsBeforeRecords: holdings.filter((h) => h.balanceBeforeRecords).length,
      perHolding: holdings.map((h) => ({
        holdingId: h.holdingId,
        accountId: 'acc',
        tokenId: h.tokenId,
        balance: new Decimal(1),
        valueInBase: h.valueInBase,
        anchorSource: 'holdings',
        pricePath: 'direct',
        priceEffectiveAt: new Date(),
        unpriceable: h.unpriceable ?? false,
        priceStale: h.priceStale ?? false,
        balanceBeforeRecords: h.balanceBeforeRecords ?? false,
      })),
    }),
  } as unknown as PortfolioValuationAtTimeService;
}

function costResult(p: Partial<CostBasisAtTime> & { hasTransactions: boolean }): CostBasisAtTime {
  return {
    openQty: p.openQty ?? new Decimal(0),
    costBasis: p.costBasis ?? new Decimal(0),
    realizedPnl: p.realizedPnl ?? new Decimal(0),
    lots: p.lots ?? [],
    hasTransactions: p.hasTransactions,
    basisQuality: p.basisQuality ?? (p.hasTransactions ? 'known' : 'unknown'),
    transfersUnreviewed: p.transfersUnreviewed ?? 0,
  };
}

function makeService(
  valuation: PortfolioValuationAtTimeService,
  costBasis: CostBasisService
): PnLAtTimeService {
  Container.set(PortfolioValuationAtTimeService, valuation);
  Container.set(CostBasisService, costBasis);
  Container.set(HoldingTransactionRepository, {} as unknown as HoldingTransactionRepository);
  Container.set(HoldingCoverageRepository, {
    findManyByHoldingIds: async () => new Map(),
  } as unknown as HoldingCoverageRepository);
  const instance = new PnLAtTimeService();
  Container.set(PnLAtTimeService, instance);
  return instance;
}

// No DB behind these tests: hand in empty caches so the service takes its
// pre-loaded path rather than reaching for a repository.
const EMPTY_CACHES: BalanceAtTimeCaches = {
  holdings: new Map(),
  observations: new Map(),
  transactions: new Map(),
};

// Minimal tx for component detection — buildTransferComponents only
// reads `transferGroupId`.
function linkTx(transferGroupId: string): HoldingTransaction {
  return { transferGroupId } as unknown as HoldingTransaction;
}

describe('PnLAtTimeService.getPnL — cost-unknown substitution', () => {
  test('a holding with no transactions reports cost basis = value (0 PnL)', async () => {
    const valuation = makeValuationStub([
      { holdingId: 'normal', tokenId: 't1', valueInBase: new Decimal(1000) },
      { holdingId: 'notx', tokenId: 't2', valueInBase: new Decimal(500) },
    ]);
    const costBasis = {
      getCostBasis: async (holdingId: string) =>
        holdingId === 'normal'
          ? costResult({
              hasTransactions: true,
              costBasis: new Decimal(700),
              realizedPnl: new Decimal(50),
            })
          : costResult({ hasTransactions: false }),
      walkComponent: async () => {
        throw new Error('walkComponent should not run — no transfers');
      },
    } as unknown as CostBasisService;
    const svc = makeService(valuation, costBasis);

    const r = await svc.getPnL('u', new Date(), USD, {
      caches: {
        transactions: new Map([
          ['normal', []],
          ['notx', []],
        ]),
      },
      tx: undefined,
    });

    const notx = r.perHolding.find((p) => p.holdingId === 'notx');
    expect(notx?.costBasis.toString()).toBe('500'); // = value, not 0
    expect(notx?.unrealizedPnl?.toString()).toBe('0'); // no fabricated gain

    const normal = r.perHolding.find((p) => p.holdingId === 'normal');
    expect(normal?.unrealizedPnl?.toString()).toBe('300'); // 1000 − 700

    expect(r.totalCostBasis.toString()).toBe('1200'); // 700 + 500
    expect(r.totalRealizedPnl.toString()).toBe('50');
    expect(r.totalUnrealizedPnl.toString()).toBe('300'); // 1500 − 1200
  });
});

describe('PnLAtTimeService.getPnL — transfer routing', () => {
  test('transfer-linked holdings are walked together, not per-holding', async () => {
    const valuation = makeValuationStub([
      { holdingId: 'X', tokenId: 't', valueInBase: new Decimal(0) },
      { holdingId: 'Y', tokenId: 't', valueInBase: new Decimal(1500) },
    ]);
    let walkComponentCalls = 0;
    const costBasis = {
      getCostBasis: async () => {
        throw new Error('getCostBasis should not run — both holdings are transfer-linked');
      },
      // `_dbTx` is the transaction SC-600 made walkComponent's first
      // parameter. This stub is cast `as unknown as CostBasisService`, so the
      // compiler never checked it against the real signature — without the
      // placeholder, `holdingIds` silently binds to the transaction and the
      // assertion below reads `undefined`. That is the whole reason the gate
      // is not redundant with a clean type-check here.
      walkComponent: async (_dbTx: unknown, holdingIds: ReadonlyArray<string>) => {
        walkComponentCalls += 1;
        expect([...holdingIds].sort()).toEqual(['X', 'Y']);
        return new Map<string, CostBasisAtTime>([
          ['X', costResult({ hasTransactions: true })],
          [
            'Y',
            costResult({
              hasTransactions: true,
              costBasis: new Decimal(1000),
              realizedPnl: new Decimal(500),
            }),
          ],
        ]);
      },
    } as unknown as CostBasisService;
    const svc = makeService(valuation, costBasis);

    const r = await svc.getPnL('u', new Date(), USD, {
      caches: {
        transactions: new Map<string, HoldingTransaction[]>([
          ['X', [linkTx('g1')]],
          ['Y', [linkTx('g1')]],
        ]),
      },
      tx: undefined,
    });

    expect(walkComponentCalls).toBe(1);
    expect(r.totalRealizedPnl.toString()).toBe('500');
    expect(r.totalCostBasis.toString()).toBe('1000');
  });
});

describe('PnLAtTimeService.getPnL — unpriceable holdings', () => {
  test('a holding excluded from the value side is excluded from the cost side', async () => {
    // Airdrop dust books a zero-cost lot, so in production this changes
    // nothing. The case it closes is dust that somehow acquired a cost:
    // its cost would land in the total while its value never could, and
    // the chart would report an unrealized loss the user never took
    // (SC-146).
    const valuation = makeValuationStub([
      { holdingId: 'real', tokenId: 't1', valueInBase: new Decimal(1000) },
      { holdingId: 'dust', tokenId: 't-spam', valueInBase: null, unpriceable: true },
    ]);
    const costBasis = {
      getCostBasis: async (holdingId: string) =>
        holdingId === 'real'
          ? costResult({ hasTransactions: true, costBasis: new Decimal(700) })
          : costResult({
              hasTransactions: true,
              costBasis: new Decimal(400),
              realizedPnl: new Decimal(25),
            }),
      walkComponent: async () => {
        throw new Error('walkComponent should not run — no transfers');
      },
    } as unknown as CostBasisService;
    const svc = makeService(valuation, costBasis);

    const r = await svc.getPnL('u', new Date(), USD, {
      caches: {
        transactions: new Map([
          ['real', []],
          ['dust', []],
        ]),
      },
      tx: undefined,
    });

    expect(r.totalCostBasis.toString()).toBe('700'); // not 1100
    expect(r.totalRealizedPnl.toString()).toBe('0'); // not 25
    expect(r.totalUnrealizedPnl.toString()).toBe('300'); // 1000 - 700, no phantom loss
    expect(r.holdingsUnpriceable).toBe(1);

    // The row survives, flagged, with its own cost intact for the
    // per-holding view — only the portfolio totals skip it.
    const dust = r.perHolding.find((p) => p.holdingId === 'dust');
    expect(dust?.unpriceable).toBe(true);
    expect(dust?.costBasis.toString()).toBe('400');
    expect(dust?.unrealizedPnl).toBeNull(); // no value, so no gain claimed
  });

  test('a holding with no value but no `unpriceable` flag is excluded too', async () => {
    // SC-505. `unpriceable` means "never had a price row AND is inside a
    // cooldown", which is one of several reasons a value comes back null.
    // A USD cash balance held by a GBP-base user has thousands of price
    // rows and still resolves to nothing, because `forex-backfill` quotes
    // every edge against USD and so never writes USD itself as the priced
    // token. Gated on the flag alone, its whole cost basis stayed in a
    // total its value never reached — drawn as a -100% loss on a cash
    // balance that had not moved.
    const valuation = makeValuationStub([
      { holdingId: 'real', tokenId: 't1', valueInBase: new Decimal(1000) },
      { holdingId: 'usd-cash', tokenId: 't-usd', valueInBase: null, unpriceable: false },
    ]);
    const costBasis = {
      getCostBasis: async (holdingId: string) =>
        holdingId === 'real'
          ? costResult({ hasTransactions: true, costBasis: new Decimal(700) })
          : costResult({
              hasTransactions: true,
              costBasis: new Decimal(9576),
              realizedPnl: new Decimal(12),
            }),
      walkComponent: async () => {
        throw new Error('walkComponent should not run — no transfers');
      },
    } as unknown as CostBasisService;
    const svc = makeService(valuation, costBasis);

    const r = await svc.getPnL('u', new Date(), USD, {
      caches: {
        transactions: new Map([
          ['real', []],
          ['usd-cash', []],
        ]),
      },
      tx: undefined,
    });

    expect(r.totalCostBasis.toString()).toBe('700'); // not 10276
    expect(r.totalRealizedPnl.toString()).toBe('0'); // not 12
    expect(r.totalUnrealizedPnl.toString()).toBe('300'); // not -9276
    // The narrow flag is untouched: this holding is not "unpriceable dust",
    // it is one we could not value today, and the coverage counts already
    // say so through `holdingsWithKnownValue`.
    expect(r.holdingsUnpriceable).toBe(0);

    const cash = r.perHolding.find((p) => p.holdingId === 'usd-cash');
    expect(cash?.costBasis.toString()).toBe('9576'); // row keeps its own basis
    expect(cash?.unrealizedPnl).toBeNull(); // and claims no loss against it
  });
});

/**
 * SC-149 / SC-151 — the counts that qualify the totals.
 *
 * These assert the *denominators*, not the money. A PnL total is only as good
 * as the fraction of holdings whose cost we actually know, and before this
 * there was no way for any surface to ask.
 */
describe('PnLAtTimeService.getPnL — quality counts', () => {
  test('a truncated holding is counted while its figures stay in the totals', async () => {
    const valuation = makeValuationStub([
      { holdingId: 'h1', tokenId: 'btc', valueInBase: new Decimal(1000) },
      { holdingId: 'h2', tokenId: 'eth', valueInBase: new Decimal(500) },
    ]);
    const costBasis = {
      walkComponent: async () => new Map(),
      getCostBasis: async (holdingId: string) =>
        costResult({
          hasTransactions: true,
          costBasis: new Decimal(holdingId === 'h1' ? 400 : 200),
          basisQuality: holdingId === 'h1' ? 'partial' : 'known',
        }),
    } as unknown as CostBasisService;
    const result = await makeService(valuation, costBasis).getPnL('u', new Date(), USD, {
      caches: EMPTY_CACHES,
      coverageByHolding: new Map(),
      tx: undefined,
    });

    expect(result.holdingsBasisUnknown).toBe(1);
    // Deliberately still in the totals. Dropping h1's 400 of cost while its
    // 1000 of value stayed would move 400 into unrealized gain — the same
    // one-directional error, committed by the fix meant to expose it.
    expect(result.totalCostBasis.toString()).toBe('600');
    expect(result.totalUnrealizedPnl.toString()).toBe('900');
  });

  test('an unpriceable holding is not counted a second time as basis-unknown', async () => {
    const valuation = makeValuationStub([
      { holdingId: 'h1', tokenId: 'btc', valueInBase: new Decimal(1000) },
      { holdingId: 'spam', tokenId: 'dust', valueInBase: null, unpriceable: true },
    ]);
    const costBasis = {
      walkComponent: async () => new Map(),
      getCostBasis: async () => costResult({ hasTransactions: false }),
    } as unknown as CostBasisService;
    const result = await makeService(valuation, costBasis).getPnL('u', new Date(), USD, {
      caches: EMPTY_CACHES,
      coverageByHolding: new Map(),
      tx: undefined,
    });

    // Airdrop spam is already outside both totals (SC-146). Reporting its
    // absent cost basis as a defect would make a fully-known portfolio read
    // as unknown — the exact shape of the bug SC-146 closed on the value side.
    expect(result.holdingsBasisUnknown).toBe(1);
    expect(result.perHolding.find((p) => p.holdingId === 'spam')?.basisQuality).toBe('unknown');
  });

  test('stale-priced holdings are re-exposed from the valuation pass', async () => {
    const valuation = makeValuationStub([
      { holdingId: 'h1', tokenId: 'btc', valueInBase: new Decimal(1000), priceStale: true },
      { holdingId: 'h2', tokenId: 'eth', valueInBase: new Decimal(500) },
    ]);
    const costBasis = {
      walkComponent: async () => new Map(),
      getCostBasis: async () => costResult({ hasTransactions: true, costBasis: new Decimal(100) }),
    } as unknown as CostBasisService;
    const result = await makeService(valuation, costBasis).getPnL('u', new Date(), USD, {
      caches: EMPTY_CACHES,
      coverageByHolding: new Map(),
      tx: undefined,
    });

    expect(result.holdingsStalePriced).toBe(1);
    expect(result.perHolding.find((p) => p.holdingId === 'h1')?.priceStale).toBe(true);
    expect(result.perHolding.find((p) => p.holdingId === 'h2')?.priceStale).toBe(false);
  });

  // SC-252, and the reason it is asserted at THIS layer rather than only at
  // the valuation pass: this mirror is where SC-249's anchor provenance was
  // lost. `unpriceable` and `priceStale` were each carried across when the
  // defect they describe was found, and nobody came back for the anchor —
  // so the valuation pass computed a signal the rollup above it never saw.
  test('before-records balances are re-exposed from the valuation pass', async () => {
    const valuation = makeValuationStub([
      {
        holdingId: 'h-awx',
        tokenId: 'usd',
        valueInBase: new Decimal(586.94),
        balanceBeforeRecords: true,
      },
      { holdingId: 'h2', tokenId: 'eth', valueInBase: new Decimal(500) },
    ]);
    const costBasis = {
      walkComponent: async () => new Map(),
      getCostBasis: async () => costResult({ hasTransactions: true, costBasis: new Decimal(100) }),
    } as unknown as CostBasisService;
    const result = await makeService(valuation, costBasis).getPnL('u', new Date(), USD, {
      caches: EMPTY_CACHES,
      coverageByHolding: new Map(),
      tx: undefined,
    });

    expect(result.holdingsBeforeRecords).toBe(1);
    expect(result.perHolding.find((p) => p.holdingId === 'h-awx')?.balanceBeforeRecords).toBe(true);
    expect(result.perHolding.find((p) => p.holdingId === 'h2')?.balanceBeforeRecords).toBe(false);
  });
});

/**
 * SC-160 — the count that says realized PnL is SHORT.
 *
 * Every other quality count on this result names an error that runs upward:
 * unknown cost inflates the gain, a stale price flatters the value. This one
 * runs the other way, because SC-150 made an unanswered withdrawal book
 * nothing rather than book an invented gain. Where such a row is a genuine
 * off-platform sale, `totalRealizedPnl` is short by it.
 *
 * The gate below is the part worth a test rather than a comment: it is the
 * same `!unpriceable` gate `holdingsBasisUnknown` uses, and for the same
 * reason. An unpriceable holding's realized PnL never entered the total, so an
 * unanswered exit out of one cannot be shortening a figure it does not
 * contribute to — and a caveat raised by airdrop dust is a caveat no answer in
 * the queue can ever clear.
 */
describe('PnLAtTimeService.getPnL — unreviewed transfers (SC-160)', () => {
  test('sums the walk’s counts and exposes them per holding', async () => {
    const valuation = makeValuationStub([
      { holdingId: 'a', tokenId: 't1', valueInBase: new Decimal(1000) },
      { holdingId: 'b', tokenId: 't2', valueInBase: new Decimal(500) },
    ]);
    const costBasis = {
      getCostBasis: async (holdingId: string) =>
        costResult({
          hasTransactions: true,
          costBasis: new Decimal(100),
          transfersUnreviewed: holdingId === 'a' ? 2 : 1,
        }),
    } as unknown as CostBasisService;
    const svc = makeService(valuation, costBasis);

    const r = await svc.getPnL('u', new Date(), USD, { caches: EMPTY_CACHES, tx: undefined });
    expect(r.transfersUnreviewed).toBe(3);
    expect(r.perHolding.find((p) => p.holdingId === 'a')?.transfersUnreviewed).toBe(2);
    expect(r.perHolding.find((p) => p.holdingId === 'b')?.transfersUnreviewed).toBe(1);
  });

  test('an unpriceable holding’s unanswered exits are not counted', async () => {
    const valuation = makeValuationStub([
      { holdingId: 'real', tokenId: 't1', valueInBase: new Decimal(1000) },
      { holdingId: 'dust', tokenId: 't2', valueInBase: null, unpriceable: true },
    ]);
    const costBasis = {
      getCostBasis: async () =>
        costResult({ hasTransactions: true, costBasis: new Decimal(100), transfersUnreviewed: 5 }),
    } as unknown as CostBasisService;
    const svc = makeService(valuation, costBasis);

    const r = await svc.getPnL('u', new Date(), USD, { caches: EMPTY_CACHES, tx: undefined });
    // 5 from `real`; `dust` contributes nothing to the total it would caveat.
    expect(r.transfersUnreviewed).toBe(5);
    // Still reported on the holding itself — the rollup's per-scope writer
    // applies the same gate, and a per-holding page may want the fact.
    expect(r.perHolding.find((p) => p.holdingId === 'dust')?.transfersUnreviewed).toBe(5);
  });
});
