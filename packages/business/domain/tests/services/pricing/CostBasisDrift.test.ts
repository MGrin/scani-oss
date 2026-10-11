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
    feeQuantity: null,
    feeTokenId: null,
    occurredAt: new Date(p.occurredAt),
    externalId: `ext-${seq}`,
    swapGroupId: null,
    transferGroupId: null,
    transferReview: p.transferReview ?? null,
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

const deposit = () =>
  tx({
    tokenId: CAD,
    kind: 'deposit',
    quantity: '1000',
    occurredAt: '2026-01-01',
    priceNative: '0.7',
  });

describe('an unexplained balance change is money in or out in the cost walk (SC-1470)', () => {
  test('an unexplained fall leaves at pool cost and realizes nothing', async () => {
    const r = await makeService().walkLots(
      undefined,
      [
        deposit(),
        tx({ tokenId: CAD, kind: 'drift_out', quantity: '-400', occurredAt: '2026-02-01' }),
      ],
      USD,
      CAD
    );
    expect(r.openQty.toString()).toBe('600');
    expect(r.costBasis.toString()).toBe('420');
    expect(r.realizedPnl.toString()).toBe('0');
  });

  test('an unexplained rise opens a lot at its worth that day, like a deposit', async () => {
    const r = await makeService().walkLots(
      undefined,
      [
        deposit(),
        tx({ tokenId: CAD, kind: 'drift_in', quantity: '200', occurredAt: '2026-02-01' }),
      ],
      USD,
      CAD
    );
    expect(r.openQty.toString()).toBe('1200');
    expect(r.costBasis.toString()).toBe('850');
  });

  test('control: the same fall as a sale realizes the move, so drift_out is not a sale', async () => {
    const r = await makeService().walkLots(
      undefined,
      [
        deposit(),
        tx({ tokenId: CAD, kind: 'settle_out', quantity: '-400', occurredAt: '2026-02-01' }),
      ],
      USD,
      CAD
    );
    expect(r.realizedPnl.toString()).toBe('20');
  });

  test('a fall the owner answered growth is a loss on the lots left, not money out', async () => {
    const r = await makeService().walkLots(
      undefined,
      [
        deposit(),
        tx({ tokenId: CAD, kind: 'drift_growth', quantity: '-400', occurredAt: '2026-02-01' }),
      ],
      USD,
      CAD
    );
    // Nothing leaves the pool: the cost stays on fewer units, which is the loss.
    expect(r.costBasis.toString()).toBe('700');
    expect(r.realizedPnl.toString()).toBe('0');
  });
});

describe('income is a gain when it arrives (SC-1470)', () => {
  test('interest on foreign cash books its worth that day as income, and the lot costs that much', async () => {
    const r = await makeService().walkLots(
      undefined,
      [deposit(), tx({ tokenId: CAD, kind: 'interest', quantity: '40', occurredAt: '2026-02-01' })],
      USD,
      CAD
    );
    expect(r.income?.toString()).toBe('30');
    expect(r.costBasis.toString()).toBe('730');
    // Control: income is not a disposal, so the realized scalar stays the rows' sum (SC-90).
    expect(r.realizedPnl.toString()).toBe('0');
  });

  test('control: a deposit is money in, not income', async () => {
    const r = await makeService().walkLots(undefined, [deposit()], USD, CAD);
    expect(r.income?.toString()).toBe('0');
  });
});
