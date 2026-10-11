process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { describe, expect, test } from 'bun:test';
import type { HoldingTransaction } from '@scani/db/schema';
import type Decimal from 'decimal.js';
import { Container } from 'typedi';
import { HoldingRepository } from '../../../src/repositories/HoldingRepository';
import { HoldingTransactionRepository } from '../../../src/repositories/HoldingTransactionRepository';
import { CostBasisService } from '../../../src/services/pricing/CostBasisService';
import { PriceReader } from '../../../src/services/pricing/PriceReader';
import { restoreContainerAfterAll } from '../../../test/helpers/container';
import { priceReaderStub } from '../../../test/helpers/price-series';

restoreContainerAfterAll();

const USD = 'token-USD';
const CAD = 'token-CAD';
const BTC = 'token-BTC';

/** CAD at 0.75 USD and BTC at 100 USD on every date; USD itself is never converted. */
function makeService(): CostBasisService {
  Container.set(HoldingRepository, {} as unknown as HoldingRepository);
  Container.set(HoldingTransactionRepository, {} as unknown as HoldingTransactionRepository);
  const rates: Record<string, string> = { [CAD]: '0.75', [BTC]: '100' };
  Container.set(
    PriceReader,
    priceReaderStub((amount: Decimal, from: string) =>
      rates[from] ? { amount: amount.mul(rates[from]), stale: false } : null
    )
  );
  const instance = new CostBasisService();
  Container.set(CostBasisService, instance);
  return instance;
}

let seq = 0;
function tx(p: {
  tokenId: string;
  kind: string;
  quantity: string;
  occurredAt: string;
  priceNative?: string;
  transferReview?: string;
  settlesTransactionId?: string;
  feeQuantity?: string;
}): HoldingTransaction {
  seq += 1;
  return {
    id: `tx-${seq}`,
    userId: 'u',
    holdingId: 'h',
    tokenId: p.tokenId,
    kind: p.kind,
    quantity: p.quantity,
    priceNative: p.priceNative ?? null,
    priceNativeTokenId: p.priceNative ? USD : null,
    counterTokenId: null,
    counterQuantity: null,
    counterPriceNative: null,
    counterPriceNativeTokenId: null,
    feeQuantity: p.feeQuantity ?? null,
    feeTokenId: p.feeQuantity ? p.tokenId : null,
    occurredAt: new Date(p.occurredAt),
    externalId: `ext-${seq}`,
    swapGroupId: null,
    transferGroupId: null,
    transferReview: p.transferReview ?? null,
    settlesTransactionId: p.settlesTransactionId ?? null,
    transferReviewSplit: null,
    transferReviewedAt: p.transferReview ? new Date() : null,
    transferReviewSource: p.transferReview ? 'user' : null,
    source: 's',
    sourceMetadata: {},
    rawPayload: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as HoldingTransaction;
}

describe('cash spent below zero is a short, closed by the cash that comes back (SC-1470)', () => {
  const walk = (rows: HoldingTransaction[]) => makeService().walkLots(undefined, rows, USD, CAD);

  test('a margin debit opens a short at what it bought, and the conversion that covers it realizes only the FX move', async () => {
    const r = await walk([
      tx({ tokenId: CAD, kind: 'settle_in', quantity: '100', occurredAt: '2026-01-01' }),
      tx({ tokenId: CAD, kind: 'settle_out', quantity: '-300', occurredAt: '2026-02-01' }),
      tx({
        tokenId: CAD,
        kind: 'buy',
        quantity: '250',
        occurredAt: '2026-03-01',
        priceNative: '0.8',
      }),
    ]);
    // 200 CAD spent short at 0.75 (150), bought back at 0.80 (160): a 10 loss.
    expect(r.realizedPnl.toString()).toBe('-10');
    expect(r.openQty.toString()).toBe('50');
    expect(r.costBasis.toString()).toBe('40');
  });

  test('while the short is open the holding carries a negative quantity and cost', async () => {
    const r = await walk([
      tx({ tokenId: CAD, kind: 'settle_in', quantity: '100', occurredAt: '2026-01-01' }),
      tx({ tokenId: CAD, kind: 'settle_out', quantity: '-300', occurredAt: '2026-02-01' }),
    ]);
    expect(r.openQty.toString()).toBe('-200');
    expect(r.costBasis.toString()).toBe('-150');
    expect(r.realizedPnl.toString()).toBe('0');
  });

  test('control: a stock sold past its recorded buys is a missing buy, not a short', async () => {
    const r = await makeService().walkLots(
      undefined,
      [
        tx({
          tokenId: BTC,
          kind: 'buy',
          quantity: '1',
          occurredAt: '2026-01-01',
          priceNative: '100',
        }),
        tx({
          tokenId: BTC,
          kind: 'sell',
          quantity: '-3',
          occurredAt: '2026-02-01',
          priceNative: '100',
        }),
      ],
      USD,
      BTC
    );
    expect(r.openQty.toString()).toBe('0');
    expect(r.realizedPnl.toString()).toBe('200');
  });

  test("a trade's settling fee spends the cash like settle_out, realizing only the FX move", async () => {
    const r = await walk([
      tx({
        tokenId: CAD,
        kind: 'deposit',
        quantity: '100',
        occurredAt: '2026-01-01',
        priceNative: '0.7',
      }),
      tx({ tokenId: CAD, kind: 'settle_in', quantity: '0.0001', occurredAt: '2026-01-02' }),
      tx({
        tokenId: CAD,
        kind: 'fee',
        quantity: '-10',
        occurredAt: '2026-02-01',
        settlesTransactionId: 'trade-1',
      }),
    ]);
    expect(r.openQty.toString()).toBe('90.0001');
    // 10 CAD bought at 0.70 left at 0.75.
    expect(r.realizedPnl.toString()).toBe('0.5');
  });

  test("an FX conversion's commission on its own leg stays a cost of the cash (SC-1464)", async () => {
    const leg = tx({
      tokenId: CAD,
      kind: 'buy',
      quantity: '100',
      occurredAt: '2026-01-01',
      priceNative: '0.7',
    });
    const rows = [
      tx({ tokenId: CAD, kind: 'settle_in', quantity: '0.0001', occurredAt: '2025-12-31' }),
      leg,
      tx({
        tokenId: CAD,
        kind: 'fee',
        quantity: '-10',
        occurredAt: '2026-01-01',
        settlesTransactionId: leg.id,
      }),
    ];
    const r = await walk(rows);
    const withoutFee = await walk(rows.slice(0, 2));
    // Not spent like a settlement: nothing realized, the 10's cost stays in the
    // pool. Its units leave, so the pool matches the balance (SC-1561).
    expect(r.realizedPnl.toString()).toBe('0');
    expect(r.openQty.toString()).toBe('90.0001');
    expect(r.costBasis.toString()).toBe(withoutFee.costBasis.toString());
  });

  // SC-1486: IBKR reports a conversion's commission twice — on the trade row
  // (`feeQuantity`) and as the fee row that settles it on the same holding. It
  // is one commission. The fee row already keeps it as a cost of the cash, so
  // the trade row may not fold it into the leg's cost as well.
  test("a conversion's commission reported on the trade AND as its own-holding fee row counts exactly once (SC-1486)", async () => {
    const leg = tx({
      tokenId: CAD,
      kind: 'buy',
      quantity: '100',
      occurredAt: '2026-01-01',
      priceNative: '0.7',
      feeQuantity: '-10',
    });
    const fee = tx({
      tokenId: CAD,
      kind: 'fee',
      quantity: '-10',
      occurredAt: '2026-01-01',
      settlesTransactionId: leg.id,
    });
    const once = await walk([leg, fee]);
    // The same conversion with the commission reported only as the fee row.
    const asFeeRowOnly = await walk([{ ...leg, feeQuantity: null, feeTokenId: null }, fee]);
    expect(once.costBasis.toString()).toBe(asFeeRowOnly.costBasis.toString());
    expect(once.realizedPnl.toString()).toBe('0');
  });

  test('control: a commission with no fee row of its own is still folded into the cost', async () => {
    const r = await walk([
      tx({
        tokenId: CAD,
        kind: 'buy',
        quantity: '100',
        occurredAt: '2026-01-01',
        priceNative: '0.7',
        feeQuantity: '-10',
      }),
    ]);
    // 100 at 0.70 plus the 10 CAD of commission, at the trade's own 0.70.
    expect(r.costBasis.toString()).toBe('77');
  });

  // Until SC-1561 a fee nothing settles stayed in the pool as a cost of the
  // cash. It leaves at zero proceeds now, and its cost is a realized loss.
  test('control: a fee nothing settles leaves the pool, its cost a realized loss', async () => {
    const r = await walk([
      tx({
        tokenId: CAD,
        kind: 'deposit',
        quantity: '100',
        occurredAt: '2026-01-01',
        priceNative: '0.7',
      }),
      tx({ tokenId: CAD, kind: 'fee', quantity: '-10', occurredAt: '2026-02-01' }),
    ]);
    expect(r.openQty.toString()).toBe('90');
    expect(r.costBasis.toString()).toBe('63');
    expect(r.realizedPnl.toString()).toBe('-7');
  });
});
