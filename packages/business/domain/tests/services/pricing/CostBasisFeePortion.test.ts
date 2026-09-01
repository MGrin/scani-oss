process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { describe, expect, test } from 'bun:test';
import type { HoldingTransaction } from '@scani/db/schema';
import { TRANSFER_REVIEW_SPLIT, type TransferReviewSplit } from '@scani/shared';
import Decimal from 'decimal.js';
import { Container } from 'typedi';
import { HoldingRepository } from '../../../src/repositories/HoldingRepository';
import { HoldingTransactionRepository } from '../../../src/repositories/HoldingTransactionRepository';
import {
  CostBasisService,
  type DisposalLotMatch,
} from '../../../src/services/pricing/CostBasisService';
import { PriceGraphService } from '../../../src/services/pricing/PriceGraphService';
import { restoreContainerAfterAll } from '../../../test/helpers/container';

/**
 * The queue's split can say part of an outflow was a fee (SC-888).
 *
 * The two answers this replaces are each false about a charge, in opposite
 * directions: `left_control` prices the fee at market and books a REALISED GAIN
 * on money the bank took, and `untracked` says it is still yours somewhere
 * Scani cannot see. The tests below are written as those two claims — a fee
 * portion must produce neither.
 *
 * The load-bearing one is the LAST: answering "3,500 paired, 500 a fee" must
 * land the destination on exactly the basis that answering `paired` for the
 * whole 4,000 lands it on today. The queue path's arithmetic was already
 * defensible (`rehome` conserves the component's cost, SC-506); this ticket is
 * about what the ledger can SAY, and a change that quietly moved cost basis
 * while saying so would be a worse bug than the silence it fixed.
 */

restoreContainerAfterAll();

const USD = 'token-USD';
const BTC = 'token-BTC';
const FUTURE = new Date('2030-01-01T00:00:00Z');
const heldTokens = new Map([
  ['A', BTC],
  ['B', BTC],
]);

function makeService(): CostBasisService {
  Container.set(HoldingRepository, {} as unknown as HoldingRepository);
  Container.set(HoldingTransactionRepository, {} as unknown as HoldingTransactionRepository);
  // Every priced row below carries `priceNative` in the base currency, so a
  // conversion means the walk reached for a price it should not have needed.
  Container.set(PriceGraphService, {
    convert: async (amount: Decimal) => ({ amount: new Decimal(amount), stale: false }),
  } as unknown as PriceGraphService);
  const instance = new CostBasisService();
  Container.set(CostBasisService, instance);
  return instance;
}

let txSeq = 0;
function tx(p: {
  holdingId: string;
  kind: string;
  quantity: string;
  occurredAt: string;
  priceNative?: string;
  transferGroupId?: string;
  transferReview?: string;
  transferReviewSplit?: TransferReviewSplit;
}): HoldingTransaction {
  txSeq += 1;
  return {
    id: `fee-tx-${txSeq}`,
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
    externalId: `fee-ext-${txSeq}`,
    swapGroupId: null,
    transferGroupId: p.transferGroupId ?? null,
    transferReview: p.transferReview ?? null,
    transferReviewSplit: p.transferReviewSplit ?? null,
    transferReviewedAt: p.transferReview ? new Date() : null,
    transferReviewSource: p.transferReview ? 'user' : null,
    transferReviewRuleId: null,
    source: 's',
    sourceMetadata: {},
    rawPayload: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as HoldingTransaction;
}

/** 40 units bought at 100, so every unit costs 100 and the sums are readable. */
function purchase() {
  return tx({
    holdingId: 'A',
    kind: 'buy',
    quantity: '40',
    occurredAt: '2024-01-01',
    priceNative: '100',
  });
}

describe('CostBasisService — a fee portion (SC-888)', () => {
  test('books no realised gain on the share the bank took', async () => {
    const svc = makeService();
    const ledger: DisposalLotMatch[] = [];
    const r = await svc.walkLots(
      undefined,
      [
        purchase(),
        tx({
          holdingId: 'A',
          kind: 'withdraw',
          // 40 out: 35 left the reader's control, 5 was the charge.
          quantity: '-40',
          occurredAt: '2024-02-01',
          priceNative: '150',
          transferReview: TRANSFER_REVIEW_SPLIT,
          transferReviewSplit: [
            { decision: 'left_control', quantity: '35' },
            { decision: 'fee', quantity: '5' },
          ],
        }),
      ],
      USD,
      BTC,
      undefined,
      'complete',
      ledger
    );

    // 35 disposed at 150 = 5,250 proceeds against 3,500 of cost = 1,750.
    // Answering `left_control` for the whole 40 books 6,000 against 4,000 —
    // 2,000 — so the 250 difference IS the gain on the bank's charge, and it
    // is the number this answer exists to stop inventing.
    expect(r.realizedPnl.toString()).toBe('1750');

    const feeRows = ledger.filter((row) => row.outcome === 'fee');
    expect(feeRows).toHaveLength(1);
    expect(feeRows[0]?.quantity.toString()).toBe('5');
    // A charge has no proceeds and therefore no gain. Not zero — zero is a
    // figure, and a fee priced at zero is what `unpriced` means.
    expect(feeRows[0]?.proceeds).toBeNull();
    expect(feeRows[0]?.gain).toBeNull();
  });

  test('does not claim the fee is still yours somewhere untracked', async () => {
    const svc = makeService();
    const ledger: DisposalLotMatch[] = [];
    await svc.walkLots(
      undefined,
      [
        purchase(),
        tx({
          holdingId: 'A',
          kind: 'withdraw',
          quantity: '-40',
          occurredAt: '2024-02-01',
          priceNative: '150',
          transferReview: TRANSFER_REVIEW_SPLIT,
          transferReviewSplit: [
            { decision: 'left_control', quantity: '35' },
            { decision: 'fee', quantity: '5' },
          ],
        }),
      ],
      USD,
      BTC,
      undefined,
      'complete',
      ledger
    );
    // `retained` is the outcome `untracked` produces, and it renders "you said
    // this never left your control". The other available answer for a fee.
    expect(ledger.some((row) => row.outcome === 'retained')).toBe(false);
  });

  test('a whole withdrawal answered `fee` realizes nothing', async () => {
    const svc = makeService();
    const ledger: DisposalLotMatch[] = [];
    const r = await svc.walkLots(
      undefined,
      [
        purchase(),
        tx({
          holdingId: 'A',
          kind: 'withdraw',
          quantity: '-2',
          occurredAt: '2024-02-01',
          priceNative: '150',
          transferReview: 'fee',
        }),
      ],
      USD,
      BTC,
      undefined,
      'complete',
      ledger
    );
    expect(r.realizedPnl.toString()).toBe('0');
    expect(ledger.filter((row) => row.outcome === 'fee')).toHaveLength(1);
  });

  test('the destination lands on the same basis as answering `paired` whole', async () => {
    // The claim the ticket makes about the queue path: `rehome` already scales
    // the buffered lots to what ARRIVED and leaves their cost alone, so the
    // charge is capitalised into the surviving units and the component's total
    // cost basis is conserved. Saying the fee out loud must not move it.
    const withFee = async () => {
      const svc = makeService();
      return svc.walkComponent(
        undefined,
        ['A', 'B'],
        new Map([
          [
            'A',
            [
              purchase(),
              tx({
                holdingId: 'A',
                kind: 'transfer_out',
                quantity: '-40',
                occurredAt: '2024-02-01',
                transferGroupId: 'g-fee',
                transferReview: TRANSFER_REVIEW_SPLIT,
                transferReviewSplit: [
                  { decision: 'paired', quantity: '35', matchTransactionId: crypto.randomUUID() },
                  { decision: 'fee', quantity: '5' },
                ],
              }),
            ],
          ],
          [
            'B',
            [
              tx({
                holdingId: 'B',
                kind: 'transfer_in',
                quantity: '35',
                occurredAt: '2024-02-01',
                transferGroupId: 'g-fee',
              }),
            ],
          ],
        ]),
        FUTURE,
        USD,
        heldTokens
      );
    };

    const asOneAnswer = async () => {
      const svc = makeService();
      return svc.walkComponent(
        undefined,
        ['A', 'B'],
        new Map([
          [
            'A',
            [
              purchase(),
              tx({
                holdingId: 'A',
                kind: 'transfer_out',
                quantity: '-40',
                occurredAt: '2024-02-01',
                transferGroupId: 'g-whole',
                transferReview: 'paired',
              }),
            ],
          ],
          [
            'B',
            [
              tx({
                holdingId: 'B',
                kind: 'transfer_in',
                quantity: '35',
                occurredAt: '2024-02-01',
                transferGroupId: 'g-whole',
              }),
            ],
          ],
        ]),
        FUTURE,
        USD,
        heldTokens
      );
    };

    const split = await withFee();
    const whole = await asOneAnswer();

    // 4,000 of cost on 35 surviving units, both ways. A control that could
    // fail: if the fee's lots were discarded instead of buffered this reads
    // 3,500, and if they were never popped A would still hold 5 units.
    expect(whole.get('B')?.costBasis.toString()).toBe('4000');
    expect(split.get('B')?.costBasis.toString()).toBe(whole.get('B')?.costBasis.toString());
    expect(split.get('B')?.openQty.toString()).toBe('35');
    expect(split.get('A')?.costBasis.toString()).toBe('0');
    expect(split.get('A')?.openQty.toString()).toBe('0');
    expect(split.get('A')?.realizedPnl.toString()).toBe('0');
  });
});
