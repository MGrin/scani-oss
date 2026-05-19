process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { afterAll, describe, expect, test } from 'bun:test';
import type { HoldingTransaction } from '@scani/db/schema';
import Decimal from 'decimal.js';
import { Container } from 'typedi';
import { HoldingTransactionRepository } from '../../../src/repositories/HoldingTransactionRepository';
import { PnLAtTimeService } from '../../../src/services/portfolio/PnLAtTimeService';
import { PortfolioValuationAtTimeService } from '../../../src/services/portfolio/PortfolioValuationAtTimeService';
import {
  type CostBasisAtTime,
  CostBasisService,
} from '../../../src/services/pricing/CostBasisService';

afterAll(() => {
  Container.set(HoldingTransactionRepository, new HoldingTransactionRepository());
  Container.set(CostBasisService, new CostBasisService());
  Container.set(PortfolioValuationAtTimeService, new PortfolioValuationAtTimeService());
  Container.set(PnLAtTimeService, new PnLAtTimeService());
});

const USD = 'token-USD';

interface ValuationHolding {
  holdingId: string;
  tokenId: string;
  valueInBase: Decimal | null;
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
      perHolding: holdings.map((h) => ({
        holdingId: h.holdingId,
        accountId: 'acc',
        tokenId: h.tokenId,
        balance: new Decimal(1),
        valueInBase: h.valueInBase,
        anchorSource: 'holdings',
        pricePath: 'direct',
        priceEffectiveAt: new Date(),
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
  };
}

function makeService(
  valuation: PortfolioValuationAtTimeService,
  costBasis: CostBasisService
): PnLAtTimeService {
  Container.set(PortfolioValuationAtTimeService, valuation);
  Container.set(CostBasisService, costBasis);
  Container.set(HoldingTransactionRepository, {} as unknown as HoldingTransactionRepository);
  const instance = new PnLAtTimeService();
  Container.set(PnLAtTimeService, instance);
  return instance;
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
      walkComponent: async (holdingIds: ReadonlyArray<string>) => {
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
    });

    expect(walkComponentCalls).toBe(1);
    expect(r.totalRealizedPnl.toString()).toBe('500');
    expect(r.totalCostBasis.toString()).toBe('1000');
  });
});
