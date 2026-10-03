process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { describe, expect, test } from 'bun:test';
import type { HoldingTransaction } from '@scani/db/schema';
import Decimal from 'decimal.js';
import { Container } from 'typedi';
import { HoldingRepository } from '../../../src/repositories/HoldingRepository';
import { HoldingTransactionRepository } from '../../../src/repositories/HoldingTransactionRepository';
import { CostBasisService } from '../../../src/services/pricing/CostBasisService';
import { PriceGraphService } from '../../../src/services/pricing/PriceGraphService';
import { DriftLedgerService } from '../../../src/services/returns/DriftLedgerService';
import { ExternalFlowService } from '../../../src/services/returns/ExternalFlowService';
import { restoreContainerAfterAll } from '../../../test/helpers/container';

/**
 * SC-1486: a row with no price of its own is valued at one instant on both
 * sides. The flow side values it at the day's close (SC-1254); the cost walk
 * priced it at its own minute, so an opening balance or a priceless trade on a
 * day the market moved left the intraday move as value change that was
 * neither a flow nor a gain — VOO's opening day read -127.97, BTC's +130.56.
 */

restoreContainerAfterAll();

const USD = 'token-USD';
const VOO = 'token-VOO';
const H = 'h-voo';
const MINUTE = new Date('2026-06-25T09:30:00Z');
const CLOSE = '2026-06-25T23:59:59.999Z';
const FROM = new Date('2026-06-24T23:59:59.999Z');
const TO = new Date('2026-06-25T23:59:59.999Z');

let seq = 0;
function row(p: Partial<HoldingTransaction> & Pick<HoldingTransaction, 'kind' | 'quantity'>) {
  seq += 1;
  return {
    id: `priceless-${seq}`,
    userId: 'u',
    holdingId: H,
    tokenId: VOO,
    priceNative: null,
    priceNativeTokenId: null,
    counterTokenId: null,
    counterQuantity: null,
    counterPriceNative: null,
    counterPriceNativeTokenId: null,
    feeQuantity: null,
    feeTokenId: null,
    settlesTransactionId: null,
    occurredAt: MINUTE,
    externalId: `priceless-ext-${seq}`,
    swapGroupId: null,
    transferGroupId: null,
    transferReview: null,
    transferReviewSplit: null,
    transferReviewedAt: null,
    transferReviewSource: null,
    transferReviewRuleId: null,
    source: 's',
    sourceMetadata: {},
    rawPayload: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...p,
  } as unknown as HoldingTransaction;
}

// VOO opens the day at 100 and closes it at 102.
function wire(rows: HoldingTransaction[]) {
  Container.set(HoldingTransactionRepository, {
    findForHoldingsInRange: async () => rows,
  } as unknown as HoldingTransactionRepository);
  Container.set(HoldingRepository, {
    findIdsIncludedInTotal: async (ids: readonly string[]) => new Set(ids),
    findByIds: async () => [{ id: H, tokenId: VOO }],
  } as unknown as HoldingRepository);
  Container.set(PriceGraphService, {
    buildPriceLookup: async () => ({ covers: () => false }),
    convert: async (amount: Decimal | string, from: string, _to: string, at: Date) => {
      if (from === USD) return { amount: new Decimal(amount), stale: false };
      if (from !== VOO) return null;
      const rate = at.toISOString() === CLOSE ? '102' : '100';
      return { amount: new Decimal(amount).mul(rate), stale: false };
    },
  } as unknown as PriceGraphService);
  Container.set(DriftLedgerService, {
    forHoldings: async () => new Map(),
  } as unknown as DriftLedgerService);
  const costBasis = new CostBasisService();
  Container.set(CostBasisService, costBasis);
  const flows = new ExternalFlowService();
  Container.set(ExternalFlowService, flows);
  return { costBasis, flows };
}

const flowOf = async (svc: ExternalFlowService) => {
  const s = await svc.forHoldings([{ holdingId: H, weight: new Decimal(1) }], USD, FROM, TO);
  return s.flows.reduce((a, f) => a.plus(f.baseAmount), new Decimal(0));
};

describe('SC-1486 — a priceless row is valued at the same instant on both sides', () => {
  test('an opening balance costs exactly its flow', async () => {
    const rows = [row({ kind: 'opening_balance', quantity: '10' })];
    const { costBasis, flows } = wire(rows);
    const walked = await costBasis.walkLots(undefined, rows, USD, VOO, undefined, 'complete');
    expect((await flowOf(flows)).toString()).toBe('1020');
    expect(walked.costBasis.toString()).toBe('1020');
  });

  test('a priceless sale realizes against the value its flow carries out', async () => {
    const buy = row({
      kind: 'buy',
      quantity: '10',
      occurredAt: new Date('2026-06-01T09:30:00Z'),
      priceNative: '90',
      priceNativeTokenId: USD,
    });
    const sell = row({ kind: 'sell', quantity: '-10' });
    const { costBasis } = wire([buy, sell]);
    const walked = await costBasis.walkLots(
      undefined,
      [buy, sell],
      USD,
      VOO,
      undefined,
      'complete'
    );
    expect((await flowOf(wire([sell]).flows)).toString()).toBe('-1020');
    // 1,020 out against 900 of cost.
    expect(walked.realizedPnl.toString()).toBe('120');
  });

  test('control: a buy with its own price keeps it', async () => {
    const buy = row({ kind: 'buy', quantity: '10', priceNative: '95', priceNativeTokenId: USD });
    const { costBasis, flows } = wire([buy]);
    const walked = await costBasis.walkLots(undefined, [buy], USD, VOO, undefined, 'complete');
    expect((await flowOf(flows)).toString()).toBe('950');
    expect(walked.costBasis.toString()).toBe('950');
  });
});
