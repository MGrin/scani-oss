process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { describe, expect, test } from 'bun:test';
import type { HoldingTransaction } from '@scani/db/schema';
import type Decimal from 'decimal.js';
import { Container } from 'typedi';
import { HoldingRepository } from '../../../src/repositories/HoldingRepository';
import { HoldingTransactionRepository } from '../../../src/repositories/HoldingTransactionRepository';
import { CostBasisService } from '../../../src/services/pricing/CostBasisService';
import { PriceGraphService } from '../../../src/services/pricing/PriceGraphService';
import { restoreContainerAfterAll } from '../../../test/helpers/container';

restoreContainerAfterAll();

const USD = 'token-USD';
const BTC = 'token-BTC';
const FUTURE = new Date('2030-01-01');
const heldTokens = new Map([
  ['A', BTC],
  ['B', BTC],
]);

// BTC is worth 150 whenever the walk asks, so a lot opened at market costs 150
// a unit and is told apart from one that carried its 100 across.
function makeService(): CostBasisService {
  Container.set(HoldingRepository, {} as unknown as HoldingRepository);
  Container.set(HoldingTransactionRepository, {} as unknown as HoldingTransactionRepository);
  Container.set(PriceGraphService, {
    convert: async (amount: Decimal, from: string) =>
      from === BTC ? { amount: amount.mul(150), stale: false } : null,
  } as unknown as PriceGraphService);
  const instance = new CostBasisService();
  Container.set(CostBasisService, instance);
  return instance;
}

let seq = 0;
function tx(p: {
  holdingId: string;
  kind: string;
  quantity: string;
  occurredAt: string;
  priceNative?: string;
  transferGroupId?: string;
}): HoldingTransaction {
  seq += 1;
  return {
    id: `tx-${seq}`,
    userId: 'u',
    holdingId: p.holdingId,
    tokenId: BTC,
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
    transferGroupId: p.transferGroupId ?? null,
    transferReview: null,
    transferReviewedAt: null,
    source: 's',
    sourceMetadata: {},
    rawPayload: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as HoldingTransaction;
}

const buy = (at: string) =>
  tx({ holdingId: 'A', kind: 'buy', quantity: '10', occurredAt: at, priceNative: '100' });
const leave = (at: string) =>
  tx({ holdingId: 'A', kind: 'withdraw', quantity: '-10', occurredAt: at, transferGroupId: 'g1' });
const arrive = (at: string) =>
  tx({
    holdingId: 'B',
    kind: 'transfer_in',
    quantity: '10',
    occurredAt: at,
    transferGroupId: 'g1',
  });
const sell = (at: string) =>
  tx({ holdingId: 'B', kind: 'sell', quantity: '-10', occurredAt: at, priceNative: '150' });

async function realized(a: HoldingTransaction[], b: HoldingTransaction[]) {
  const r = await makeService().walkComponent(
    undefined,
    ['A', 'B'],
    new Map([
      ['A', a],
      ['B', b],
    ]),
    FUTURE,
    USD,
    heldTokens
  );
  return [r.get('A')?.realizedPnl.toString(), r.get('B')?.realizedPnl.toString()];
}

// SC-1486: a chain stamps the arrival of an exchange withdrawal a minute or two
// BEFORE the exchange stamps its departure. Walked in time order the arrival
// found no lots, opened one at market, and the lots that left were never
// claimed, so their gain reached nobody.
describe('CostBasisService — a linked arrival stamped before its departure (SC-1486)', () => {
  test('it still carries the cost across', async () => {
    expect(
      await realized(
        [buy('2022-01-01T00:00:00Z'), leave('2022-01-12T15:54:00Z')],
        [arrive('2022-01-12T15:52:00Z'), sell('2022-03-01T00:00:00Z')]
      )
    ).toEqual(['0', '500']);
  });

  test('a source buy inside the gap still funds the departure', async () => {
    expect(
      await realized(
        [buy('2022-01-12T15:53:00Z'), leave('2022-01-12T15:54:00Z')],
        [arrive('2022-01-12T15:52:00Z'), sell('2022-03-01T00:00:00Z')]
      )
    ).toEqual(['0', '500']);
  });

  test('control: a departure-first pair is unchanged', async () => {
    expect(
      await realized(
        [buy('2022-01-01T00:00:00Z'), leave('2022-01-12T15:52:00Z')],
        [arrive('2022-01-12T15:54:00Z'), sell('2022-03-01T00:00:00Z')]
      )
    ).toEqual(['0', '500']);
  });

  test('control: an arrival more than ten minutes early is left where it is', async () => {
    const [, b] = await realized(
      [buy('2022-01-01T00:00:00Z'), leave('2022-01-12T16:10:00Z')],
      [arrive('2022-01-12T15:52:00Z'), sell('2022-03-01T00:00:00Z')]
    );
    expect(b).toBe('0');
  });

  test('control: an arrival the destination already spent in the gap is left where it is', async () => {
    const [, b] = await realized(
      [buy('2022-01-01T00:00:00Z'), leave('2022-01-12T15:54:00Z')],
      [arrive('2022-01-12T15:52:00Z'), sell('2022-01-12T15:53:00Z')]
    );
    expect(b).toBe('0');
  });
});
