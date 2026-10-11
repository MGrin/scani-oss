process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { describe, expect, test } from 'bun:test';
import type { HoldingTransaction } from '@scani/db/schema';
import Decimal from 'decimal.js';
import { Container } from 'typedi';
import { HoldingRepository } from '../../../src/repositories/HoldingRepository';
import { HoldingTransactionRepository } from '../../../src/repositories/HoldingTransactionRepository';
import { PriceReader } from '../../../src/services/pricing/PriceReader';
import { DriftLedgerService } from '../../../src/services/returns/DriftLedgerService';
import {
  ExternalFlowService,
  netFlowByDate,
} from '../../../src/services/returns/ExternalFlowService';
import { restoreContainerAfterAll } from '../../../test/helpers/container';
import { noPriceReader } from '../../../test/helpers/price-series';

/**
 * SC-1453: a single-row trade's cash side, written as a settlement on the cash
 * holding, cancels the trade at account scope.
 *
 * The fixture is the plan's: 2 VOO bought at 500 USD, paid for by a `settle_out`
 * of 1,000 on the USD holding, with a 1 USD commission as its own `fee` row
 * that settles the buy. Since SC-1470 the commission is part of what the buy
 * put in (1,001) and its fee row is the cash leaving for it (-1), so the three
 * still cancel at account scope.
 * Before settlements the buy was an external contribution of 1,000 at every
 * scope, and the USD holding's drop existed only as drift.
 *
 * Both legs are denominated in the base currency, so no price lookup is needed
 * and the stub refuses one: a test that silently reached for a price would be
 * valuing the settlement some way other than the one under test.
 */

restoreContainerAfterAll();

const USD = 'token-USD';
const VOO = 'token-VOO';
const VOO_HOLDING = 'h-voo';
const USD_HOLDING = 'h-usd';
const TRADE_DAY = '2026-07-14';
const FROM = new Date('2026-07-13T23:59:59.999Z');
const TO = new Date('2026-07-15T23:59:59.999Z');

let seq = 0;
function row(
  p: Partial<HoldingTransaction> &
    Pick<HoldingTransaction, 'kind' | 'holdingId' | 'tokenId' | 'quantity'>
): HoldingTransaction {
  seq += 1;
  return {
    id: `settle-tx-${seq}`,
    userId: 'u',
    priceNative: null,
    priceNativeTokenId: null,
    counterTokenId: null,
    counterQuantity: null,
    counterPriceNative: null,
    counterPriceNativeTokenId: null,
    feeQuantity: null,
    feeTokenId: null,
    occurredAt: new Date(`${TRADE_DAY}T14:30:00Z`),
    externalId: `settle-ext-${seq}`,
    swapGroupId: null,
    transferGroupId: null,
    transferReview: null,
    transferReviewSplit: null,
    transferReviewedAt: null,
    transferReviewSource: null,
    transferReviewRuleId: null,
    settlesTransactionId: null,
    source: 'ibkr-api',
    sourceMetadata: {},
    rawPayload: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...p,
  } as unknown as HoldingTransaction;
}

const BUY_ID = 'settle-buy';
const buy = () =>
  row({
    id: BUY_ID,
    kind: 'buy',
    holdingId: VOO_HOLDING,
    tokenId: VOO,
    quantity: '2',
    priceNative: '500',
    priceNativeTokenId: USD,
    counterTokenId: USD,
    counterQuantity: '-1000',
    feeTokenId: USD,
    feeQuantity: '-1',
    externalId: 'ibkr-trade-1',
  });

const settlement = (extra: Partial<HoldingTransaction> = {}) =>
  row({
    kind: 'settle_out',
    holdingId: USD_HOLDING,
    tokenId: USD,
    quantity: '-1000',
    externalId: 'ibkr-trade-1:settle',
    sourceMetadata: { settles: 'ibkr-trade-1' },
    ...extra,
  });

const commission = () =>
  row({
    kind: 'fee',
    holdingId: USD_HOLDING,
    tokenId: USD,
    quantity: '-1',
    externalId: 'ibkr-trade-1:fee',
    settlesTransactionId: BUY_ID,
    sourceMetadata: { settles: 'ibkr-trade-1' },
  });

function makeService(rows: HoldingTransaction[]): ExternalFlowService {
  Container.set(HoldingTransactionRepository, {
    findForHoldingsInRange: async (holdingIds: string[]) =>
      rows.filter((r) => holdingIds.includes(r.holdingId)),
  } as unknown as HoldingTransactionRepository);
  Container.set(HoldingRepository, {
    findIdsIncludedInTotal: async (ids: readonly string[]) => new Set(ids),
    findByIds: async () => [
      { id: VOO_HOLDING, tokenId: VOO },
      { id: USD_HOLDING, tokenId: USD },
    ],
  } as unknown as HoldingRepository);
  Container.set(PriceReader, noPriceReader);
  Container.set(DriftLedgerService, {
    forHoldings: async () => new Map(),
  } as unknown as DriftLedgerService);
  const instance = new ExternalFlowService();
  Container.set(ExternalFlowService, instance);
  return instance;
}

const ACCOUNT = [
  { holdingId: VOO_HOLDING, weight: new Decimal(1) },
  { holdingId: USD_HOLDING, weight: new Decimal(1) },
];

const net = (flows: { baseAmount: string }[]) =>
  flows.reduce((sum, flow) => sum.plus(flow.baseAmount), new Decimal(0));

describe('ExternalFlowService — a trade and its settlement (SC-1453)', () => {
  test('at account scope the buy and its settlement cancel on the trade day', async () => {
    const svc = makeService([buy(), settlement(), commission()]);
    const series = await svc.forHoldings(ACCOUNT, USD, FROM, TO);

    expect(series.flows.map((f) => [f.kind, f.baseAmount])).toEqual([
      ['buy', '1001'],
      ['settle_out', '-1000'],
      ['fee', '-1'],
    ]);
    expect(net(series.flows).toString()).toBe('0');
    const { byDate } = netFlowByDate(series.flows, [TRADE_DAY]);
    expect(byDate.get(TRADE_DAY)?.toString()).toBe('0');
  });

  test('the stock alone shows the buy as 1,001 in: its price and its commission', async () => {
    const svc = makeService([buy(), settlement(), commission()]);
    const series = await svc.forHoldings(
      [{ holdingId: VOO_HOLDING, weight: new Decimal(1) }],
      USD,
      FROM,
      TO
    );
    expect(series.flows.map((f) => [f.kind, f.baseAmount])).toEqual([['buy', '1001']]);
  });

  test('the cash alone shows the settlement and the commission leaving, 1,001 out', async () => {
    const svc = makeService([buy(), settlement(), commission()]);
    const series = await svc.forHoldings(
      [{ holdingId: USD_HOLDING, weight: new Decimal(1) }],
      USD,
      FROM,
      TO
    );
    // The commission is a cost once, in the stock's cost basis (SC-1470); the
    // cash only paid it, so here it is money out.
    expect(series.flows.map((f) => [f.kind, f.baseAmount])).toEqual([
      ['settle_out', '-1000'],
      ['fee', '-1'],
    ]);
    expect(series.unvaluedCount).toBe(0);
  });

  test('a settlement is never an unresolved flow', async () => {
    const svc = makeService([buy(), settlement(), commission()]);
    const series = await svc.forHoldings(ACCOUNT, USD, FROM, TO);
    expect(series.unresolvedCount).toBe(0);
    expect(series.problemsByHolding.size).toBe(0);
  });

  test('a sale and its settlement cancel the same way', async () => {
    const svc = makeService([
      buy(),
      row({
        kind: 'sell',
        holdingId: VOO_HOLDING,
        tokenId: VOO,
        quantity: '-2',
        priceNative: '510',
        priceNativeTokenId: USD,
        counterTokenId: USD,
        counterQuantity: '1020',
        externalId: 'ibkr-trade-2',
      }),
      settlement(),
      settlement({
        kind: 'settle_in',
        quantity: '1020',
        externalId: 'ibkr-trade-2:settle',
        sourceMetadata: { settles: 'ibkr-trade-2' },
      }),
      commission(),
    ]);
    const series = await svc.forHoldings(ACCOUNT, USD, FROM, TO);
    expect(net(series.flows).toString()).toBe('0');
  });

  /**
   * Why a settlement row carries no price. The two legs cancel only because
   * both are valued at the same 1,000 USD; a leg priced at the trade's
   * per-unit rate would be valued at 500 per dollar. Counter fields alone
   * change nothing, since only a swap leg is revalued at its arrival.
   */
  test("CONTROL: a settlement carrying the trade's price stops cancelling; counter fields alone do not", async () => {
    const priced = makeService([
      buy(),
      settlement({ priceNative: '500', priceNativeTokenId: USD }),
    ]);
    const pricedSeries = await priced.forHoldings(ACCOUNT, USD, FROM, TO);
    expect(net(pricedSeries.flows).toString()).not.toBe('0');

    const countered = makeService([
      buy(),
      settlement({ counterTokenId: VOO, counterQuantity: '2' }),
      commission(),
    ]);
    const counteredSeries = await countered.forHoldings(ACCOUNT, USD, FROM, TO);
    expect(net(counteredSeries.flows).toString()).toBe('0');
  });
});
