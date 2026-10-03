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
 * SC-1475: a swap leg's cost (or proceeds) is the same number as its external
 * flow, valued at the same instant.
 *
 * The flow side values a swap leg at what ARRIVED, at the day's close
 * (SC-1438). The cost walk kept each leg's execution rate at its own
 * timestamp, so a swap-in with slippage put one number into the lot and
 * another into the flow, and the difference showed up as value change that
 * was neither a flow nor a gain. With one shared valuation the lot costs
 * exactly its flow, and the slippage is realized by the swap-out that paid it.
 */

restoreContainerAfterAll();

const GBP = 'token-GBP';
const USDT = 'token-USDT';
const ETH = 'token-ETH';
const USDT_HOLDING = 'h-usdt';
const ETH_HOLDING = 'h-eth';
const FROM = new Date('2024-03-13T23:59:59.999Z');
const TO = new Date('2024-03-14T23:59:59.999Z');
const CLOSE = '2024-03-14T23:59:59.999Z';
// 1,000 USDT is £800 at spot; the 0.4 ETH given for it is £840.
const RATES: Record<string, Decimal> = {
  [USDT]: new Decimal('0.8'),
  [ETH]: new Decimal('2100'),
};

let seq = 0;
function row(
  p: Partial<HoldingTransaction> &
    Pick<HoldingTransaction, 'kind' | 'holdingId' | 'tokenId' | 'quantity'>
): HoldingTransaction {
  seq += 1;
  return {
    id: `swap-leg-${seq}`,
    userId: 'u',
    priceNative: null,
    priceNativeTokenId: null,
    counterTokenId: null,
    counterQuantity: null,
    counterPriceNative: null,
    counterPriceNativeTokenId: null,
    feeQuantity: null,
    feeTokenId: null,
    occurredAt: new Date('2024-03-14T10:07:00Z'),
    externalId: `swap-leg-ext-${seq}`,
    swapGroupId: 'sg',
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

// 0.4 ETH for 1,000 USDT, recorded at an execution rate that values the
// swap at £840 while what arrived is worth £800: £40 of slippage.
const swapIn = () =>
  row({
    kind: 'swap_in',
    holdingId: USDT_HOLDING,
    tokenId: USDT,
    quantity: '1000',
    priceNative: '0.0004',
    priceNativeTokenId: ETH,
    counterTokenId: ETH,
    counterQuantity: '-0.4',
  });

// The recorded rate says 0.4 ETH fetched 1,040 USDT (£832); 1,000 USDT
// (£800) is what arrived. Main realized against the recorded rate (-£8); the
// shared valuation realizes against what arrived (-£40).
const swapOut = () =>
  row({
    kind: 'swap_out',
    holdingId: ETH_HOLDING,
    tokenId: ETH,
    quantity: '-0.4',
    priceNative: '2600',
    priceNativeTokenId: USDT,
    counterTokenId: USDT,
    counterQuantity: '1000',
  });

const ethBuy = () =>
  row({
    kind: 'buy',
    holdingId: ETH_HOLDING,
    tokenId: ETH,
    quantity: '0.4',
    occurredAt: new Date('2024-03-01T10:00:00Z'),
    priceNative: '2100',
    priceNativeTokenId: GBP,
  });

interface Call {
  from: string;
  at: Date;
}

function wire(rows: HoldingTransaction[], calls: Call[] = []) {
  Container.set(HoldingTransactionRepository, {
    findForHoldingsInRange: async () => rows,
  } as unknown as HoldingTransactionRepository);
  Container.set(HoldingRepository, {
    findIdsIncludedInTotal: async (ids: readonly string[]) => new Set(ids),
    findByIds: async () => [
      { id: USDT_HOLDING, tokenId: USDT },
      { id: ETH_HOLDING, tokenId: ETH },
    ],
  } as unknown as HoldingRepository);
  Container.set(PriceGraphService, {
    buildPriceLookup: async () => ({ covers: () => false }),
    convert: async (amount: Decimal | string, from: string, _to: string, at: Date) => {
      calls.push({ from, at });
      if (from === GBP) return { amount: new Decimal(amount), stale: false };
      const rate = RATES[from];
      return rate ? { amount: new Decimal(amount).mul(rate), stale: false } : null;
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

const flowOf = async (svc: ExternalFlowService, holdingId: string) => {
  const s = await svc.forHoldings([{ holdingId, weight: new Decimal(1) }], GBP, FROM, TO);
  return s.flows.reduce((a, f) => a.plus(f.baseAmount), new Decimal(0));
};

describe('SC-1475 — a swap leg costs exactly its flow', () => {
  test('a swap-in with slippage: the lot costs what arrived, and so does the flow', async () => {
    const rows = [swapIn()];
    const calls: Call[] = [];
    const { costBasis, flows } = wire(rows, calls);

    const walked = await costBasis.walkLots(undefined, rows, GBP, USDT, undefined, 'complete');
    const flow = await flowOf(flows, USDT_HOLDING);

    expect(flow.toString()).toBe('800');
    expect(walked.costBasis.toString()).toBe('800');
    // Valued at the day's close, the instant the flow and the rollup read.
    expect(calls.every((c) => c.at.toISOString() === CLOSE)).toBe(true);
  });

  test('the swap-out realizes the slippage, and its proceeds equal its flow', async () => {
    const out = swapOut();
    const rows = [ethBuy(), out];
    const { costBasis } = wire(rows);

    const walked = await costBasis.walkLots(undefined, rows, GBP, ETH, undefined, 'complete');
    // The swap-out's own flow; the earlier buy is money in of its own.
    const flow = await flowOf(wire([out]).flows, ETH_HOLDING);

    // £840 of ETH left for £800 of USDT: the £40 lost is a realized loss.
    expect(flow.toString()).toBe('-800');
    expect(walked.realizedPnl.toString()).toBe('-40');
    expect(walked.openQty.toString()).toBe('0');
  });

  test('control: a plain buy keeps its execution-rate cost', async () => {
    const buy = row({
      kind: 'buy',
      holdingId: ETH_HOLDING,
      tokenId: ETH,
      quantity: '1',
      priceNative: '2000',
      priceNativeTokenId: GBP,
    });
    const { costBasis } = wire([buy]);

    const walked = await costBasis.walkLots(undefined, [buy], GBP, ETH, undefined, 'complete');

    // Spot is £2,100; the lot costs the £2,000 actually paid.
    expect(walked.costBasis.toString()).toBe('2000');
  });
});
