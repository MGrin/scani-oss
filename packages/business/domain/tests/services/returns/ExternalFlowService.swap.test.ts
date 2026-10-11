process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { describe, expect, test } from 'bun:test';
import type { HoldingTransaction } from '@scani/db/schema';
import Decimal from 'decimal.js';
import { Container } from 'typedi';
import { HoldingRepository } from '../../../src/repositories/HoldingRepository';
import { HoldingTransactionRepository } from '../../../src/repositories/HoldingTransactionRepository';
import { PriceReader } from '../../../src/services/pricing/PriceReader';
import { DriftLedgerService } from '../../../src/services/returns/DriftLedgerService';
import { ExternalFlowService } from '../../../src/services/returns/ExternalFlowService';
import { restoreContainerAfterAll } from '../../../test/helpers/container';
import { priceReaderStub } from '../../../test/helpers/price-series';

/**
 * SC-1438: a swap leg is valued at the market value of the token that ARRIVED.
 *
 * The shape that found it: USDT swapped in for ETH, then the same USDT sent on
 * two minutes later. Valued at what was given up, the swap-in read more than
 * the transfer out, so a day on which no token left the owner's hands booked
 * the slippage as money arriving, and All moved by tens of percent for it.
 *
 * Both legs of one swap take the same number (the arrival's), so a swap with
 * both holdings in scope still cancels, and the slippage lands on the side
 * that paid it rather than reading as money the owner moved.
 */

restoreContainerAfterAll();

const GBP = 'token-GBP';
const USDT = 'token-USDT';
const ETH = 'token-ETH';
const USDT_HOLDING = 'h-usdt';
const ETH_HOLDING = 'h-eth';
const FROM = new Date('2024-03-13T23:59:59.999Z');
const TO = new Date('2024-03-14T23:59:59.999Z');
// 1,000 USDT is £800; the 0.4 ETH given for it is £840.
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
    id: `swap-tx-${seq}`,
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
    externalId: `swap-ext-${seq}`,
    swapGroupId: null,
    transferGroupId: 'tg',
    transferReview: 'untracked',
    transferReviewSplit: null,
    transferReviewedAt: new Date(),
    transferReviewSource: 'user',
    transferReviewRuleId: null,
    source: 's',
    sourceMetadata: {},
    rawPayload: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...p,
  } as unknown as HoldingTransaction;
}

const swapIn = (extra: Partial<HoldingTransaction> = {}) =>
  row({
    kind: 'swap_in',
    holdingId: USDT_HOLDING,
    tokenId: USDT,
    quantity: '1000',
    // 0.4 ETH for 1,000 USDT: the execution rate, in ETH per USDT.
    priceNative: '0.0004',
    priceNativeTokenId: ETH,
    counterTokenId: ETH,
    counterQuantity: '-0.4',
    swapGroupId: 'sg',
    ...extra,
  });

const swapOut = () =>
  row({
    kind: 'swap_out',
    holdingId: ETH_HOLDING,
    tokenId: ETH,
    quantity: '-0.4',
    priceNative: '2500',
    priceNativeTokenId: USDT,
    counterTokenId: USDT,
    counterQuantity: '1000',
    swapGroupId: 'sg',
  });

function makeService(rows: HoldingTransaction[], unpriced: string[] = []): ExternalFlowService {
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
  Container.set(
    PriceReader,
    priceReaderStub((amount: Decimal, from: string) => {
      if (unpriced.includes(from)) return null;
      const rate = RATES[from];
      return rate ? { amount: new Decimal(amount).mul(rate), stale: false } : null;
    })
  );
  Container.set(DriftLedgerService, {
    forHoldings: async () => new Map(),
  } as unknown as DriftLedgerService);
  const instance = new ExternalFlowService();
  Container.set(ExternalFlowService, instance);
  return instance;
}

const net = (flows: { baseAmount: string }[]) =>
  flows.reduce((a, f) => a.plus(f.baseAmount), new Decimal(0));

describe('SC-1438 — a swap leg is valued at what arrived', () => {
  test('a swap in and the same quantity sent on the same day net to zero', async () => {
    const svc = makeService([
      swapIn(),
      row({
        kind: 'transfer_out',
        holdingId: USDT_HOLDING,
        tokenId: USDT,
        quantity: '-1000',
        occurredAt: new Date('2024-03-14T10:09:00Z'),
      }),
    ]);
    const s = await svc.forHoldings(
      [{ holdingId: USDT_HOLDING, weight: new Decimal(1) }],
      GBP,
      FROM,
      TO
    );
    expect(s.flows).toHaveLength(2);
    expect(net(s.flows).toNumber()).toBe(0);
  });

  test('CONTROL: a lone swap in is still an inflow, at the arriving token value', async () => {
    const svc = makeService([swapIn()]);
    const s = await svc.forHoldings(
      [{ holdingId: USDT_HOLDING, weight: new Decimal(1) }],
      GBP,
      FROM,
      TO
    );
    expect(Number(s.flows[0]?.baseAmount)).toBeCloseTo(800, 2);
    expect(s.flows[0]?.valuationBasis).toBe('held_token');
  });

  test('both legs of one swap take the same number, so the swap cancels with both in scope', async () => {
    const svc = makeService([swapIn(), swapOut()]);
    const s = await svc.forHoldings(
      [
        { holdingId: USDT_HOLDING, weight: new Decimal(1) },
        { holdingId: ETH_HOLDING, weight: new Decimal(1) },
      ],
      GBP,
      FROM,
      TO
    );
    expect(s.flows).toHaveLength(2);
    expect(net(s.flows).toNumber()).toBe(0);
    // The ETH side alone gives up what arrived, not what the ETH was worth: the
    // slippage stays in that side's value series, as the cost it was.
    const out = s.flows.find((f) => f.holdingId === ETH_HOLDING);
    expect(Number(out?.baseAmount)).toBeCloseTo(-800, 2);
  });

  test('an arriving token nothing prices falls back to the execution rate', async () => {
    const svc = makeService([swapIn()], [USDT]);
    const s = await svc.forHoldings(
      [{ holdingId: USDT_HOLDING, weight: new Decimal(1) }],
      GBP,
      FROM,
      TO
    );
    expect(s.flows[0]?.valuationBasis).toBe('execution_rate');
    expect(Number(s.flows[0]?.baseAmount)).toBeCloseTo(840, 2);
  });
});
