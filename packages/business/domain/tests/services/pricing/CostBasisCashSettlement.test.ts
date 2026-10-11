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

describe('a trade settlement spends or receives the cash it names (SC-1467)', () => {
  test('settle_out takes its lots out of the cash pool and books the FX move on them', async () => {
    const r = await makeService().walkLots(
      undefined,
      [
        tx({
          tokenId: CAD,
          kind: 'deposit',
          quantity: '1000',
          occurredAt: '2026-01-01',
          priceNative: '0.7',
        }),
        tx({ tokenId: CAD, kind: 'settle_out', quantity: '-400', occurredAt: '2026-02-01' }),
      ],
      USD,
      CAD
    );
    expect(r.openQty.toString()).toBe('600');
    expect(r.costBasis.toString()).toBe('420');
    // 400 CAD left at 0.75 against the 0.70 they were bought at.
    expect(r.realizedPnl.toString()).toBe('20');
  });

  test('settle_in opens a lot at what the cash was worth that day', async () => {
    const r = await makeService().walkLots(
      undefined,
      [
        tx({
          tokenId: CAD,
          kind: 'deposit',
          quantity: '1000',
          occurredAt: '2026-01-01',
          priceNative: '0.7',
        }),
        tx({ tokenId: CAD, kind: 'settle_in', quantity: '200', occurredAt: '2026-02-01' }),
      ],
      USD,
      CAD
    );
    expect(r.openQty.toString()).toBe('1200');
    expect(r.costBasis.toString()).toBe('850');
    expect(r.realizedPnl.toString()).toBe('0');
  });
});

describe('a unit of the base currency costs one unit (SC-1467)', () => {
  test('base-currency cash leaving beyond its recorded lots realizes nothing', async () => {
    const r = await makeService().walkLots(
      undefined,
      [
        tx({ tokenId: USD, kind: 'deposit', quantity: '100', occurredAt: '2026-01-01' }),
        tx({
          tokenId: USD,
          kind: 'withdraw',
          quantity: '-300',
          occurredAt: '2026-02-01',
          transferReview: 'left_control',
        }),
      ],
      USD,
      USD
    );
    expect(r.realizedPnl.toString()).toBe('0');
  });

  test('control: any other token leaving beyond its lots still realizes at zero cost', async () => {
    const r = await makeService().walkLots(
      undefined,
      [
        tx({
          tokenId: BTC,
          kind: 'deposit',
          quantity: '1',
          occurredAt: '2026-01-01',
          priceNative: '100',
        }),
        tx({
          tokenId: BTC,
          kind: 'withdraw',
          quantity: '-3',
          occurredAt: '2026-02-01',
          transferReview: 'left_control',
        }),
      ],
      USD,
      BTC
    );
    expect(r.realizedPnl.toString()).toBe('200');
  });
});
