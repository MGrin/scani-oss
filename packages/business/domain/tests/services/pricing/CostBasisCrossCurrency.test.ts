process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { describe, expect, test } from 'bun:test';
import type { HoldingTransaction } from '@scani/db/schema';
import type Decimal from 'decimal.js';
import { Container } from 'typedi';
import { HoldingRepository } from '../../../src/repositories/HoldingRepository';
import { HoldingTransactionRepository } from '../../../src/repositories/HoldingTransactionRepository';
import {
  CostBasisService,
  type HistoryCompleteness,
} from '../../../src/services/pricing/CostBasisService';
import { PriceGraphService } from '../../../src/services/pricing/PriceGraphService';
import { restoreContainerAfterAll } from '../../../test/helpers/container';

// Container stubs are process-global; put back whatever this file changes
// so no later test file resolves them (SC-448).
restoreContainerAfterAll();

/**
 * A paired transfer moves an asset. A CONVERSION does not (SC-506).
 *
 * `walkComponent` used to hand the destination of a paired transfer the
 * SOURCE's lot quantities. For a same-asset move that is right to within the
 * network fee; for a EUR -> GBP conversion it measures a sterling account in
 * euros. Measured on the SC-465 demo seed before the fix: a GBP current
 * account ended the window holding 45,444.82 lot units against a balance of
 * 11,380.08, its pool valued at 0.844 per unit instead of 1.000, and the
 * eighteen months of ordinary bills paid out of it booked 24,351.47 of
 * "realized gain" with no sale anywhere in the ledger.
 *
 * The check these tests hold the code to is not a fixture. **A GBP-base reader
 * cannot make a capital gain on sterling** — TCGA 1992 s21(1)(b) makes
 * currency *other than* sterling an asset, and sterling is the unit the gain
 * is measured in, so proceeds and cost are identically equal. Any figure other
 * than 0.00 on a sterling disposal is wrong on arithmetic, not on policy, and
 * it is wrong in the direction that costs a reader money with HMRC.
 */

const GBP = 'token-GBP';
const EUR = 'token-EUR';
const BTC = 'token-BTC';

/** EUR is worth 0.85 GBP throughout; nothing else converts. */
function makeService(): CostBasisService {
  Container.set(HoldingRepository, {} as unknown as HoldingRepository);
  Container.set(HoldingTransactionRepository, {} as unknown as HoldingTransactionRepository);
  Container.set(PriceGraphService, {
    convert: async (amount: Decimal, from: string, to: string) => {
      if (from === to) return { amount, stale: false };
      if (from === EUR && to === GBP) return { amount: amount.mul('0.85'), stale: false };
      return null;
    },
  } as unknown as PriceGraphService);
  const instance = new CostBasisService();
  Container.set(CostBasisService, instance);
  return instance;
}

let txSeq = 0;
function tx(p: {
  holdingId: string;
  tokenId: string;
  kind: string;
  quantity: string;
  occurredAt: string;
  transferGroupId?: string;
  transferReview?: string;
}): HoldingTransaction {
  txSeq += 1;
  return {
    id: `tx-${txSeq}`,
    userId: 'u',
    holdingId: p.holdingId,
    tokenId: p.tokenId,
    kind: p.kind,
    quantity: p.quantity,
    priceNative: null,
    priceNativeTokenId: null,
    counterTokenId: null,
    counterQuantity: null,
    counterPriceNative: null,
    counterPriceNativeTokenId: null,
    feeQuantity: null,
    feeTokenId: null,
    occurredAt: new Date(p.occurredAt),
    externalId: `ext-${txSeq}`,
    swapGroupId: null,
    transferGroupId: p.transferGroupId ?? null,
    transferReview: p.transferReview ?? null,
    transferReviewSplit: null,
    transferReviewedAt: p.transferReview ? new Date() : null,
    source: 's',
    sourceMetadata: {},
    rawPayload: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as HoldingTransaction;
}

const byHolding = (txs: HoldingTransaction[]): Map<string, HoldingTransaction[]> => {
  const out = new Map<string, HoldingTransaction[]>();
  for (const t of txs) {
    const list = out.get(t.holdingId);
    if (list) list.push(t);
    else out.set(t.holdingId, [t]);
  }
  return out;
};

const complete = (ids: string[]) =>
  new Map<string, HistoryCompleteness>(ids.map((id) => [id, 'complete']));

describe('cross-currency paired transfers (SC-506)', () => {
  test('a EUR -> GBP conversion does not carry euro lot units into the sterling pool', async () => {
    const svc = makeService();
    const txs = [
      tx({
        holdingId: 'eur',
        tokenId: EUR,
        kind: 'deposit',
        quantity: '12900',
        occurredAt: '2025-01-01',
      }),
      tx({
        holdingId: 'eur',
        tokenId: EUR,
        kind: 'transfer_out',
        quantity: '-12900',
        occurredAt: '2025-02-01',
        transferGroupId: 'fx1',
      }),
      tx({
        holdingId: 'gbp',
        tokenId: GBP,
        kind: 'transfer_in',
        quantity: '11000',
        occurredAt: '2025-02-01',
        transferGroupId: 'fx1',
      }),
    ];

    const out = await svc.walkComponent(
      ['eur', 'gbp'],
      byHolding(txs),
      new Date('2026-01-01'),
      GBP,
      new Map([
        ['eur', EUR],
        ['gbp', GBP],
      ]),
      undefined,
      complete(['eur', 'gbp'])
    );

    const gbp = out.get('gbp');
    if (!gbp) throw new Error('no gbp row');
    // The units that ARRIVED, not the 12,900 that left a different asset.
    expect(gbp.openQty.toFixed(2)).toBe('11000.00');
    // A sterling balance is worth its face value to a sterling reader.
    expect(gbp.costBasis.toFixed(2)).toBe('11000.00');
    // The conversion is not a sale the walk may invent on its own.
    expect(gbp.realizedPnl.toFixed(2)).toBe('0.00');
  });

  test('sterling disposals after a conversion realize exactly nothing', async () => {
    const svc = makeService();
    const txs = [
      tx({
        holdingId: 'eur',
        tokenId: EUR,
        kind: 'deposit',
        quantity: '12900',
        occurredAt: '2025-01-01',
      }),
      tx({
        holdingId: 'eur',
        tokenId: EUR,
        kind: 'transfer_out',
        quantity: '-12900',
        occurredAt: '2025-02-01',
        transferGroupId: 'fx1',
      }),
      tx({
        holdingId: 'gbp',
        tokenId: GBP,
        kind: 'transfer_in',
        quantity: '11000',
        occurredAt: '2025-02-01',
        transferGroupId: 'fx1',
      }),
      // An ordinary bill, answered: the money left, and it is sterling.
      tx({
        holdingId: 'gbp',
        tokenId: GBP,
        kind: 'withdraw',
        quantity: '-5000',
        occurredAt: '2025-03-01',
        transferReview: 'left_control',
      }),
    ];

    const out = await svc.walkComponent(
      ['eur', 'gbp'],
      byHolding(txs),
      new Date('2026-01-01'),
      GBP,
      new Map([
        ['eur', EUR],
        ['gbp', GBP],
      ]),
      undefined,
      complete(['eur', 'gbp'])
    );

    const gbp = out.get('gbp');
    if (!gbp) throw new Error('no gbp row');
    // Before SC-506 this booked 5000 x (1 - 0.85) = 750.00 of pure invention.
    expect(gbp.realizedPnl.toFixed(2)).toBe('0.00');
    expect(gbp.openQty.toFixed(2)).toBe('6000.00');
    expect(gbp.costBasis.toFixed(2)).toBe('6000.00');
  });

  test('a same-asset transfer carries its whole cost onto the units the fee left behind', async () => {
    const svc = makeService();
    const txs = [
      tx({
        holdingId: 'kraken',
        tokenId: BTC,
        kind: 'deposit',
        quantity: '0.5',
        occurredAt: '2025-01-01',
      }),
      tx({
        holdingId: 'kraken',
        tokenId: BTC,
        kind: 'withdraw',
        quantity: '-0.5',
        occurredAt: '2025-02-01',
        transferGroupId: 'move',
      }),
      tx({
        holdingId: 'ledger',
        tokenId: BTC,
        kind: 'transfer_in',
        quantity: '0.49284214',
        occurredAt: '2025-02-01',
        transferGroupId: 'move',
      }),
    ];

    // BTC has no route to GBP here, so the deposit opens an unpriced zero-cost
    // lot. Quantity is the whole of what this asserts, and it is the half of
    // the defect that is live in production: 10 of 69 transfer groups drift.
    const out = await svc.walkComponent(
      ['kraken', 'ledger'],
      byHolding(txs),
      new Date('2026-01-01'),
      GBP,
      new Map([
        ['kraken', BTC],
        ['ledger', BTC],
      ]),
      undefined,
      complete(['kraken', 'ledger'])
    );

    const ledger = out.get('ledger');
    const kraken = out.get('kraken');
    if (!ledger || !kraken) throw new Error('missing holding');
    expect(ledger.openQty.toFixed(8)).toBe('0.49284214');
    expect(kraken.openQty.toFixed(8)).toBe('0.00000000');
  });

  test('cost is conserved across a lossy same-asset move, not scaled away with the fee', async () => {
    const svc = makeService();
    const txs = [
      // Priced in the base currency directly, so the lot has a real cost.
      tx({
        holdingId: 'a',
        tokenId: GBP,
        kind: 'deposit',
        quantity: '1000',
        occurredAt: '2025-01-01',
      }),
      tx({
        holdingId: 'a',
        tokenId: GBP,
        kind: 'transfer_out',
        quantity: '-1000',
        occurredAt: '2025-02-01',
        transferGroupId: 'g',
      }),
      tx({
        holdingId: 'b',
        tokenId: GBP,
        kind: 'transfer_in',
        quantity: '990',
        occurredAt: '2025-02-01',
        transferGroupId: 'g',
      }),
    ];

    const out = await svc.walkComponent(
      ['a', 'b'],
      byHolding(txs),
      new Date('2026-01-01'),
      GBP,
      new Map([
        ['a', GBP],
        ['b', GBP],
      ]),
      undefined,
      complete(['a', 'b'])
    );

    const b = out.get('b');
    if (!b) throw new Error('no b');
    expect(b.openQty.toFixed(2)).toBe('990.00');
    // The 10 units the transfer consumed were a cost of moving, not a disposal:
    // the component's cost basis survives the move intact.
    expect(b.costBasis.toFixed(2)).toBe('1000.00');
  });

  test('scaling a multi-lot buffer lands exactly on the arrival, so nothing is priced as a shortfall', async () => {
    const svc = makeService();
    const txs = [
      tx({
        holdingId: 'a',
        tokenId: GBP,
        kind: 'deposit',
        quantity: '1',
        occurredAt: '2025-01-01',
      }),
      tx({
        holdingId: 'a',
        tokenId: GBP,
        kind: 'deposit',
        quantity: '1',
        occurredAt: '2025-01-02',
      }),
      tx({
        holdingId: 'a',
        tokenId: GBP,
        kind: 'deposit',
        quantity: '1',
        occurredAt: '2025-01-03',
      }),
      tx({
        holdingId: 'a',
        tokenId: GBP,
        kind: 'transfer_out',
        quantity: '-3',
        occurredAt: '2025-02-01',
        transferGroupId: 'g',
      }),
      tx({
        holdingId: 'b',
        tokenId: GBP,
        kind: 'transfer_in',
        // A third of the arrival is unrepresentable in decimal.
        quantity: '2.9999999',
        occurredAt: '2025-02-01',
        transferGroupId: 'g',
      }),
      tx({
        holdingId: 'b',
        tokenId: GBP,
        kind: 'withdraw',
        quantity: '-2.9999999',
        occurredAt: '2025-03-01',
        transferReview: 'left_control',
      }),
    ];

    const out = await svc.walkComponent(
      ['a', 'b'],
      byHolding(txs),
      new Date('2026-01-01'),
      GBP,
      new Map([
        ['a', GBP],
        ['b', GBP],
      ]),
      undefined,
      complete(['a', 'b'])
    );

    const b = out.get('b');
    if (!b) throw new Error('no b');
    expect(b.openQty.toFixed(7)).toBe('0.0000000');
    // The pool landed EXACTLY on the arrival, so the disposal drew all of it
    // and booked the 0.0000001 the transfer consumed as the small loss it is.
    // A scaling that undershot would leave the disposal short of lots, and
    // `drawPooled` prices a shortfall as pure gain — the tell would be a
    // realized figure near +2.9999999 rather than near zero.
    expect(b.realizedPnl.toFixed(7)).toBe('-0.0000001');
  });
});
