process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { describe, expect, test } from 'bun:test';
import type { HoldingTransaction } from '@scani/db/schema';
import Decimal from 'decimal.js';
import { Container } from 'typedi';
import { HoldingRepository } from '../../../src/repositories/HoldingRepository';
import { HoldingTransactionRepository } from '../../../src/repositories/HoldingTransactionRepository';
import { CostBasisService } from '../../../src/services/pricing/CostBasisService';
import { PriceGraphService } from '../../../src/services/pricing/PriceGraphService';
import { restoreContainerAfterAll } from '../../../test/helpers/container';

/**
 * At one instant on one holding, an ungrouped `transfer_in` is walked before an
 * ungrouped `transfer_out` (SC-1561).
 *
 * The shared ledger order puts outflows first so a linked departure buffers its
 * lots before its arrival reaches for them. Two UNLINKED legs at one instant
 * have no such pairing, and outflow-first made the departure find the pool
 * short and the arrival then open a lot nothing ever consumed: a holding that
 * holds nothing kept a cost. Trades and linked legs keep outflow-first.
 */

restoreContainerAfterAll();

const USD = 'token-USD';
const SOL = 'token-SOL';
const T0 = '2024-01-01T00:00:00Z';
const T1 = '2024-03-01T12:00:00Z';

function makeService(): CostBasisService {
  Container.set(HoldingRepository, {} as unknown as HoldingRepository);
  Container.set(HoldingTransactionRepository, {} as unknown as HoldingTransactionRepository);
  Container.set(PriceGraphService, {
    convert: async (amount: Decimal) => ({ amount: new Decimal(amount), stale: false }),
  } as unknown as PriceGraphService);
  const instance = new CostBasisService();
  Container.set(CostBasisService, instance);
  return instance;
}

let txSeq = 0;
function tx(p: {
  kind: string;
  quantity: string;
  occurredAt: string;
  priceNative?: string;
  transferGroupId?: string;
  externalId?: string;
}): HoldingTransaction {
  txSeq += 1;
  return {
    id: `si-tx-${txSeq}`,
    userId: 'u',
    holdingId: 'A',
    tokenId: SOL,
    kind: p.kind,
    quantity: p.quantity,
    priceNative: p.priceNative ?? null,
    priceNativeTokenId: p.priceNative ? USD : null,
    counterTokenId: null,
    counterQuantity: null,
    counterPriceNative: null,
    counterPriceNativeTokenId: null,
    feeQuantity: null,
    feeTokenId: null,
    settlesTransactionId: null,
    occurredAt: new Date(p.occurredAt),
    externalId: p.externalId ?? `si-ext-${txSeq}`,
    swapGroupId: null,
    transferGroupId: p.transferGroupId ?? null,
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
  } as unknown as HoldingTransaction;
}

const walk = (rows: HoldingTransaction[]) =>
  makeService().walkLots(undefined, rows, USD, SOL, undefined, 'complete');

describe('CostBasisService — unlinked legs at one instant (SC-1561)', () => {
  test('an unlinked arrival funds the departure stamped with it', async () => {
    // 10 held; at one instant 2 arrive and 12 leave. The balance ends at 0.
    const r = await walk([
      tx({ kind: 'deposit', quantity: '10', occurredAt: T0, priceNative: '100' }),
      tx({ kind: 'transfer_out', quantity: '-12', occurredAt: T1, priceNative: '150' }),
      tx({ kind: 'transfer_in', quantity: '2', occurredAt: T1, priceNative: '150' }),
    ]);
    expect(r.openQty.toString()).toBe('0');
    expect(r.costBasis.toString()).toBe('0');
    expect(r.lots).toHaveLength(0);
  });

  test('control: a sell at the instant of a buy still cannot spend that buy', async () => {
    const r = await walk([
      tx({ kind: 'buy', quantity: '10', occurredAt: T0, priceNative: '100' }),
      tx({ kind: 'sell', quantity: '-12', occurredAt: T1, priceNative: '150' }),
      tx({ kind: 'buy', quantity: '2', occurredAt: T1, priceNative: '150' }),
    ]);
    expect(r.openQty.toString()).toBe(CONTROL_TRADE.openQty);
    expect(r.costBasis.toString()).toBe(CONTROL_TRADE.costBasis);
    expect(r.realizedPnl.toString()).toBe(CONTROL_TRADE.realizedPnl);
  });

  test('control: linked legs at one instant keep outflow-first', async () => {
    const r = await walk([
      tx({ kind: 'deposit', quantity: '10', occurredAt: T0, priceNative: '100' }),
      tx({
        kind: 'transfer_out',
        quantity: '-12',
        occurredAt: T1,
        priceNative: '150',
        transferGroupId: 'g1',
      }),
      tx({
        kind: 'transfer_in',
        quantity: '2',
        occurredAt: T1,
        priceNative: '150',
        transferGroupId: 'g1',
      }),
    ]);
    expect(r.openQty.toString()).toBe(CONTROL_LINKED.openQty);
    expect(r.costBasis.toString()).toBe(CONTROL_LINKED.costBasis);
    expect(r.realizedPnl.toString()).toBe(CONTROL_LINKED.realizedPnl);
  });
});

// Read off the walk BEFORE SC-1561 changed anything, on this file's own rows.
const CONTROL_TRADE = { openQty: '2', costBasis: '300', realizedPnl: '800' };
const CONTROL_LINKED = { openQty: '2', costBasis: '1000', realizedPnl: '0' };
