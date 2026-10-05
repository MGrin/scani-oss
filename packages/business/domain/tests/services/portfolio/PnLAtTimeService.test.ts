process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { describe, expect, spyOn, test } from 'bun:test';
import type { HoldingTransaction } from '@scani/db/schema';
import Decimal from 'decimal.js';
import { Container } from 'typedi';
import { HoldingBalanceObservationRepository } from '../../../src/repositories/HoldingBalanceObservationRepository';
import { HoldingCoverageRepository } from '../../../src/repositories/HoldingCoverageRepository';
import { HoldingTransactionRepository } from '../../../src/repositories/HoldingTransactionRepository';
import { PnLAtTimeService } from '../../../src/services/portfolio/PnLAtTimeService';
import { PortfolioValuationAtTimeService } from '../../../src/services/portfolio/PortfolioValuationAtTimeService';
import type { BalanceAtTimeCaches } from '../../../src/services/pricing/BalanceAtTimeService';
import {
  type CostBasisAtTime,
  CostBasisService,
} from '../../../src/services/pricing/CostBasisService';
import { DriftLedgerService } from '../../../src/services/returns/DriftLedgerService';
import { TransferReviewService } from '../../../src/services/TransferReviewService';
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
    income: p.income ?? new Decimal(0),
    lots: p.lots ?? [],
    hasTransactions: p.hasTransactions,
    basisQuality: p.basisQuality ?? (p.hasTransactions ? 'known' : 'unknown'),
    transfersUnreviewed: p.transfersUnreviewed ?? 0,
    feesRealized: p.feesRealized ?? new Set(),
  };
}

function makeService(
  valuation: PortfolioValuationAtTimeService,
  costBasis: CostBasisService
): PnLAtTimeService {
  Container.set(PortfolioValuationAtTimeService, valuation);
  Container.set(CostBasisService, costBasis);
  Container.set(HoldingTransactionRepository, {} as unknown as HoldingTransactionRepository);
  // The queue's rule-hidden set (SC-1067). Empty here: every case in this
  // file is about the aggregation, and an empty set is the state in which the
  // walk's own count reaches the result unchanged — which is what these
  // assertions are checking. The agreement between this count and the queue is
  // asserted against a real database in
  // `tests/services/TransferReviewCountMatchesQueue.test.ts`; a stub could
  // only agree with itself.
  Container.set(TransferReviewService, {
    ruleHiddenTransactionIds: async () => new Set<string>(),
  } as unknown as TransferReviewService);
  Container.set(HoldingCoverageRepository, {
    findManyByHoldingIds: async () => new Map(),
  } as unknown as HoldingCoverageRepository);
  Container.set(DriftLedgerService, {
    forHoldings: async () => new Map(),
  } as unknown as DriftLedgerService);
  const instance = new PnLAtTimeService();
  Container.set(PnLAtTimeService, instance);
  return instance;
}

// No DB behind these tests: hand in a ledger, an empty one, for every holding
// the valuation stub names, so the service takes its pre-loaded path rather
// than reaching for a repository. A holding left out of the map is read from
// the database (SC-1546).
function noLedgers(...holdingIds: string[]): BalanceAtTimeCaches {
  return {
    holdings: new Map(),
    observations: new Map(),
    transactions: new Map(holdingIds.map((id) => [id, []])),
  };
}

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
      caches: noLedgers('h1', 'h2'),
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
      caches: noLedgers('h1', 'spam'),
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
      caches: noLedgers('h1', 'h2'),
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
      caches: noLedgers('h-awx', 'h2'),
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

    const r = await svc.getPnL('u', new Date(), USD, {
      caches: noLedgers('a', 'b'),
      tx: undefined,
    });
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

    const r = await svc.getPnL('u', new Date(), USD, {
      caches: noLedgers('real', 'dust'),
      tx: undefined,
    });
    // 5 from `real`; `dust` contributes nothing to the total it would caveat.
    expect(r.transfersUnreviewed).toBe(5);
    // Still reported on the holding itself — the rollup's per-scope writer
    // applies the same gate, and a per-holding page may want the fact.
    expect(r.perHolding.find((p) => p.holdingId === 'dust')?.transfersUnreviewed).toBe(5);
  });
});

describe('PnLAtTimeService.getPnL — base-currency cash (SC-1467)', () => {
  test('base-currency cash carries its own value as cost basis, whatever lots the walk left', async () => {
    const valuation = makeValuationStub([
      { holdingId: 'usd', tokenId: USD, valueInBase: new Decimal(19) },
      { holdingId: 'cad', tokenId: 'token-CAD', valueInBase: new Decimal(54) },
    ]);
    const costBasis = {
      getCostBasis: async (holdingId: string) =>
        costResult({
          hasTransactions: true,
          costBasis: new Decimal(holdingId === 'usd' ? 9921 : 60),
          realizedPnl: new Decimal(holdingId === 'usd' ? -16 : 3),
        }),
      walkComponent: async () => {
        throw new Error('walkComponent should not run — no transfers');
      },
    } as unknown as CostBasisService;
    const r = await makeService(valuation, costBasis).getPnL('u', new Date(), USD, {
      caches: {
        transactions: new Map([
          ['usd', []],
          ['cad', []],
        ]),
      },
      tx: undefined,
    });
    const usd = r.perHolding.find((p) => p.holdingId === 'usd');
    expect(usd?.costBasis.toString()).toBe('19');
    expect(usd?.unrealizedPnl?.toString()).toBe('0');
    expect(usd?.realizedPnl.toString()).toBe('-16');
    // Control: foreign cash keeps the walk's basis, so its FX move stays in PnL.
    const cad = r.perHolding.find((p) => p.holdingId === 'cad');
    expect(cad?.costBasis.toString()).toBe('60');
    expect(cad?.unrealizedPnl?.toString()).toBe('-6');
  });
});

describe('PnLAtTimeService.getPnL — base-currency cash income (SC-1470)', () => {
  const row = (kind: string, quantity: string, occurredAt: string, id = `${kind}-${occurredAt}`) =>
    ({
      id,
      kind,
      quantity,
      occurredAt: new Date(occurredAt),
      transferGroupId: null,
      settlesTransactionId: null,
    }) as unknown as HoldingTransaction;

  test('income the walk booked is gain on every holding; base cash counts its fee once', async () => {
    const valuation = makeValuationStub([
      { holdingId: 'usd', tokenId: USD, valueInBase: new Decimal(500) },
      { holdingId: 'cad', tokenId: 'token-CAD', valueInBase: new Decimal(54) },
    ]);
    const costBasis = {
      getCostBasis: async (holdingId: string) =>
        costResult({
          hasTransactions: true,
          costBasis: new Decimal(holdingId === 'usd' ? 480 : 50),
          // The walk realizes the -2 fee itself since SC-1561: -16 and the fee.
          realizedPnl: new Decimal(holdingId === 'usd' ? -18 : 3),
          feesRealized: new Set(holdingId === 'usd' ? ['fee-2026-04-01'] : []),
          // What the walk booked at receipt: 10 interest + 3 reward, and 5 CAD-worth.
          income: new Decimal(holdingId === 'usd' ? 13 : 5),
        }),
      walkComponent: async () => {
        throw new Error('walkComponent should not run — no transfers');
      },
    } as unknown as CostBasisService;
    const r = await makeService(valuation, costBasis).getPnL(
      'u',
      new Date('2026-06-30T23:59:59Z'),
      USD,
      {
        caches: {
          transactions: new Map([
            [
              'usd',
              [
                row('deposit', '400', '2026-01-01'),
                row('interest', '10', '2026-02-01'),
                row('reward', '3', '2026-03-01'),
                row('fee', '-2', '2026-04-01'),
                row('interest', '5', '2026-08-01'),
              ],
            ],
            ['cad', [row('interest', '7', '2026-02-01')]],
          ]),
        },
        tx: undefined,
      }
    );
    const usd = r.perHolding.find((p) => p.holdingId === 'usd');
    // -18 walked (the fee included), +13 income. baseCashFees adding the fee
    // again read -7: one fee counted twice (SC-1561).
    expect(usd?.realizedPnl.toString()).toBe('-5');
    expect(usd?.unrealizedPnl?.toString()).toBe('0');
    // Foreign cash's income is gain too; it used to sit only in its lots' cost.
    const cad = r.perHolding.find((p) => p.holdingId === 'cad');
    expect(cad?.realizedPnl.toString()).toBe('8');
  });

  test('a commission the walk had to realize is not added again (SC-1561)', async () => {
    // A same-holding commission keeps its cost on the lots left, but with no
    // lot left the walk realizes it. Whatever the walk realized, it reports.
    const valuation = makeValuationStub([
      { holdingId: 'usd', tokenId: USD, valueInBase: new Decimal(0) },
    ]);
    const trade = row('sell', '-100', '2026-04-01', 'trade');
    const commission = {
      ...row('fee', '-3', '2026-04-01', 'commission'),
      settlesTransactionId: 'trade',
    } as HoldingTransaction;
    const costBasis = {
      getCostBasis: async () =>
        costResult({
          hasTransactions: true,
          realizedPnl: new Decimal(-3),
          feesRealized: new Set(['commission']),
        }),
      walkComponent: async () => {
        throw new Error('walkComponent should not run — no transfers');
      },
    } as unknown as CostBasisService;
    const r = await makeService(valuation, costBasis).getPnL(
      'u',
      new Date('2026-06-30T23:59:59Z'),
      USD,
      { caches: { transactions: new Map([['usd', [trade, commission]]]) }, tx: undefined }
    );
    expect(r.perHolding.find((p) => p.holdingId === 'usd')?.realizedPnl.toString()).toBe('-3');
  });
});

describe('PnLAtTimeService.getPnL — an unexplained balance change walks as money (SC-1470)', () => {
  const at = new Date('2026-10-01T23:59:59.999Z');
  const valuation = makeValuationStub([
    { holdingId: 'g', tokenId: 't', valueInBase: new Decimal(1000) },
  ]);
  const reading = (observedAt: string, balance: string, gapReview: string | null = null) => ({
    holdingId: 'g',
    observedAt: new Date(observedAt),
    balance,
    gapReview,
  });

  async function walkedRows(
    ledger: HoldingTransaction[],
    readings: ReturnType<typeof reading>[],
    // What the rollup caches: only the anchor readings for its days (SC-1283).
    cachedAnchors: ReturnType<typeof reading>[] = readings
  ): Promise<Array<[string, string]>> {
    let seen: ReadonlyArray<HoldingTransaction> = [];
    const spy = {
      getCostBasis: async (
        _h: string,
        _at: Date,
        _b: string,
        o: { txs?: HoldingTransaction[] }
      ) => {
        seen = o.txs ?? [];
        return costResult({ hasTransactions: seen.length > 0 });
      },
    } as unknown as CostBasisService;
    makeService(valuation, spy);
    Container.set(HoldingBalanceObservationRepository, {
      findReadingsForHoldings: async () => new Map([['g', readings]]),
    } as unknown as HoldingBalanceObservationRepository);
    Container.set(DriftLedgerService, new DriftLedgerService());
    await new PnLAtTimeService().getPnL('u', at, USD, {
      caches: {
        holdings: new Map(),
        transactions: new Map([['g', ledger]]),
        observations: new Map([['g', cachedAnchors]]),
      } as unknown as BalanceAtTimeCaches,
      tx: undefined,
    });
    return seen.map((t) => [t.kind, t.quantity]);
  }

  test('a holding with no ledger arrives as money in at its first reading, and its fall leaves as money out', async () => {
    expect(
      await walkedRows(
        [],
        [reading('2026-03-02T10:00:00Z', '4'), reading('2026-03-02T20:00:00Z', '3')]
      )
    ).toEqual([
      ['drift_in', '4'],
      ['drift_out', '-1'],
    ]);
  });

  test("a chunked rollup's anchor cache does not change the rows: they come from every reading", async () => {
    const first = reading('2026-03-02T10:00:00Z', '4');
    const last = reading('2026-03-09T10:00:00Z', '6');
    const all = [first, reading('2026-03-05T10:00:00Z', '7'), last];
    const full = await walkedRows([], all);
    expect(await walkedRows([], all, [first, last])).toEqual(full);
    // A gap's change is spread over its days; what matters is the totals.
    const sum = (kind: string) =>
      full
        .filter(([k]) => k === kind)
        .reduce((total, [, q]) => total.add(q), new Decimal(0))
        .toString();
    expect(sum('drift_in')).toBe('7');
    expect(sum('drift_out')).toBe('-1');
  });

  test('a rise the owner answered growth is walked as earned, not as money in', async () => {
    expect(
      await walkedRows(
        [ledgerRow('g', 'deposit', '4', '2026-03-01T00:00:00Z')],
        [reading('2026-03-02T10:00:00Z', '4'), reading('2026-03-02T20:00:00Z', '5', 'growth')]
      )
    ).toEqual([
      ['deposit', '4'],
      ['drift_growth', '1'],
    ]);
  });

  test('control: a change the ledger explains adds nothing to the walk', async () => {
    expect(
      await walkedRows(
        [
          ledgerRow('g', 'deposit', '4', '2026-03-01T00:00:00Z'),
          ledgerRow('g', 'deposit', '1', '2026-03-02T15:00:00Z'),
        ],
        [reading('2026-03-02T10:00:00Z', '4'), reading('2026-03-02T20:00:00Z', '5')]
      )
    ).toEqual([
      ['deposit', '4'],
      ['deposit', '1'],
    ]);
  });
});

/**
 * SC-1546. The rollup handed a ledger map listing visible holdings only, the
 * valuation also counted the ones the closed-position sweep hid, and a holding
 * absent from the map was read as having no transactions: its readings became
 * drift and its cost was walked from those alone.
 */
describe('PnLAtTimeService.getPnL: a handed ledger narrower than the valuation (SC-1546)', () => {
  const at = new Date('2026-10-01T23:59:59.999Z');
  const valuation = makeValuationStub([
    { holdingId: 'listed', tokenId: 't', valueInBase: new Decimal(100) },
    { holdingId: 'unlisted', tokenId: 't', valueInBase: new Decimal(0) },
  ]);
  // What the database holds. `unlisted` bought 10 and sold them, and its two
  // readings say the same: with its ledger in hand nothing is unexplained.
  const stored = new Map<string, HoldingTransaction[]>([
    ['listed', [ledgerRow('listed', 'buy', '1', '2026-03-01T00:00:00Z')]],
    [
      'unlisted',
      [
        ledgerRow('unlisted', 'buy', '10', '2026-03-01T00:00:00Z'),
        ledgerRow('unlisted', 'sell', '-10', '2026-03-05T00:00:00Z'),
      ],
    ],
    ['late', [ledgerRow('late', 'buy', '2', '2026-03-01T00:00:00Z')]],
  ]);
  const readings = [
    { observedAt: new Date('2026-03-02T10:00:00Z'), balance: '10', gapReview: null },
    { observedAt: new Date('2026-03-09T10:00:00Z'), balance: '0', gapReview: null },
  ];

  // The warning is the subject of two tests below and noise in the third.
  function muteWarnings(service: PnLAtTimeService) {
    const { logger } = service as unknown as {
      logger: { warn: (context: unknown, message: string) => void };
    };
    return spyOn(logger, 'warn').mockImplementation(() => {});
  }

  function harness(valued: PortfolioValuationAtTimeService = valuation) {
    const bulkReads: string[][] = [];
    let readingReads = 0;
    const walked = new Map<string, string[]>();
    // Answers from the rows it is handed, so a wrong walk is a wrong figure.
    const costBasis = {
      getCostBasis: async (
        holdingId: string,
        _at: Date,
        _b: string,
        o: { txs?: HoldingTransaction[] }
      ) => {
        const kinds = (o.txs ?? []).map((t) => t.kind);
        walked.set(holdingId, kinds);
        return costResult({
          hasTransactions: kinds.length > 0,
          realizedPnl: new Decimal(500).mul(kinds.filter((k) => k === 'sell').length),
        });
      },
    } as unknown as CostBasisService;
    makeService(valued, costBasis);
    Container.set(HoldingTransactionRepository, {
      findForHoldingsAll: async (ids: string[]) => {
        bulkReads.push(ids);
        return new Map(ids.map((id) => [id, stored.get(id) ?? []]));
      },
    } as unknown as HoldingTransactionRepository);
    Container.set(HoldingBalanceObservationRepository, {
      findReadingsForHoldings: async () => {
        readingReads += 1;
        return new Map([['unlisted', readings]]);
      },
    } as unknown as HoldingBalanceObservationRepository);
    Container.set(DriftLedgerService, new DriftLedgerService());
    const service = new PnLAtTimeService();
    const ask = async (transactions?: Map<string, HoldingTransaction[]>) => {
      const r = await service.getPnL('u', at, USD, {
        ...(transactions ? { caches: { transactions } } : {}),
        tx: undefined,
      });
      return {
        walked: new Map(walked),
        realized: r.perHolding.map((p) => [p.holdingId, p.realizedPnl.toString()]),
      };
    };
    return { service, ask, bulkReads, readingReads: () => readingReads };
  }

  test('a holding the handed ledger lacks is walked from its own ledger, as with no caches at all', async () => {
    const adHoc = await harness().ask();
    expect(adHoc.walked.get('unlisted')).toEqual(['buy', 'sell']);

    const narrow = harness();
    const warned = muteWarnings(narrow.service);
    try {
      const handed = await narrow.ask(new Map([['listed', stored.get('listed') ?? []]]));
      expect(handed).toEqual(adHoc);
      // One bulk read, for the missing holding and nothing else.
      expect(narrow.bulkReads).toEqual([['unlisted']]);
    } finally {
      warned.mockRestore();
    }
  });

  test('a complete handed ledger is passed on as the same object, and nothing is read', async () => {
    const h = harness();
    let passedOn: unknown;
    Container.set(DriftLedgerService, {
      forHoldings: async (_u: string, _t: unknown, o: { transactions?: unknown }) => {
        passedOn = o.transactions;
        return new Map();
      },
    } as unknown as DriftLedgerService);
    const handed = new Map(stored);
    await new PnLAtTimeService().getPnL('u', at, USD, {
      caches: { transactions: handed },
      tx: undefined,
    });
    expect(passedOn).toBe(handed);
    expect(h.bulkReads).toEqual([]);
  });

  test('a narrow ledger handed for several days is completed once and warned about once, by count', async () => {
    const h = harness();
    const warned = muteWarnings(h.service);
    try {
      const handed = new Map([['listed', stored.get('listed') ?? []]]);
      for (let day = 0; day < 3; day += 1) await h.ask(handed);
      expect(h.bulkReads).toEqual([['unlisted']]);
      expect(h.readingReads()).toBe(1);
      // The count and nothing else: a holding id never reaches a log line.
      expect(warned.mock.calls.map(([context]) => context)).toEqual([{ holdingsMissing: 1 }]);
    } finally {
      warned.mockRestore();
    }
  });

  // The holdings a valuation counts can grow between days handed one map: a
  // completed ledger is itself checked against each day's holdings.
  test('a holding first counted on a later day is read then, and only then', async () => {
    const days = [
      ['listed', 'unlisted'],
      ['listed', 'unlisted', 'late'],
      ['listed', 'unlisted'],
    ].map((counted) =>
      makeValuationStub(
        counted.map((holdingId) => ({ holdingId, tokenId: 't', valueInBase: new Decimal(0) }))
      )
    );
    let day = 0;
    const h = harness({
      getPortfolioValue: (
        ...args: Parameters<PortfolioValuationAtTimeService['getPortfolioValue']>
      ) => days[day++]!.getPortfolioValue(...args),
    } as unknown as PortfolioValuationAtTimeService);
    const warned = muteWarnings(h.service);
    try {
      const handed = new Map([['listed', stored.get('listed') ?? []]]);
      await h.ask(handed);
      const second = await h.ask(handed);
      expect(h.bulkReads).toEqual([['unlisted'], ['late']]);
      expect(second.walked.get('late')).toEqual(['buy']);

      await h.ask(handed);
      expect(h.bulkReads).toEqual([['unlisted'], ['late']]);
      // Warned about the map once, not once per holding it turned out to lack.
      expect(warned.mock.calls.map(([context]) => context)).toEqual([{ holdingsMissing: 1 }]);
    } finally {
      warned.mockRestore();
    }
  });
});

function ledgerRow(
  holdingId: string,
  kind: string,
  quantity: string,
  occurredAt: string
): HoldingTransaction {
  return {
    id: `${kind}-${occurredAt}`,
    holdingId,
    tokenId: 't',
    kind,
    quantity,
    occurredAt: new Date(occurredAt),
  } as HoldingTransaction;
}
