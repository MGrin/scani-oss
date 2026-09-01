process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { describe, expect, test } from 'bun:test';
import type { HoldingTransaction } from '@scani/db/schema';
import { TRANSFER_REVIEW_SPLIT, type TransferReviewSplit } from '@scani/shared';
import Decimal from 'decimal.js';
import { Container } from 'typedi';
import { HoldingRepository } from '../../../src/repositories/HoldingRepository';
import { HoldingTransactionRepository } from '../../../src/repositories/HoldingTransactionRepository';
import { PriceGraphService } from '../../../src/services/pricing/PriceGraphService';
import { ExternalFlowService } from '../../../src/services/returns/ExternalFlowService';
import { restoreContainerAfterAll } from '../../../test/helpers/container';

/**
 * A fee answer reaches the RETURN figure, and that is the whole of SC-888's
 * measurable half.
 *
 * `flowRoleOf('fee')` is `return` — value the portfolio CONSUMED — so a
 * `kind='fee'` ROW is dropped from the external flows entirely and its effect
 * on the value series stays in the return as a cost. The queue cannot write
 * that row (`splitSumMatches` makes the portion a carve-out of a quantity
 * already in the ledger), so the share is subtracted here instead.
 *
 * The direction matters and is asserted rather than described: booked as an
 * external outflow the charge reads as money the OWNER took out, which hides
 * the cost and OVERSTATES the return. That is the failure this is about.
 */

restoreContainerAfterAll();

const USD = 'token-USD';
const HOLDING = 'h-1';
const FROM = new Date('2024-01-01T00:00:00Z');
const TO = new Date('2024-12-31T00:00:00Z');

let txSeq = 0;
function withdrawal(p: {
  quantity: string;
  transferReview?: string;
  transferReviewSplit?: TransferReviewSplit;
}): HoldingTransaction {
  txSeq += 1;
  return {
    id: `flow-tx-${txSeq}`,
    userId: 'u',
    holdingId: HOLDING,
    tokenId: USD,
    kind: 'withdraw',
    quantity: p.quantity,
    // Denominated in the base currency, so nothing has to be converted and a
    // price lookup cannot silently decide the answer.
    priceNative: '1',
    priceNativeTokenId: USD,
    counterTokenId: null,
    counterQuantity: null,
    counterPriceNative: null,
    counterPriceNativeTokenId: null,
    feeQuantity: null,
    feeTokenId: null,
    occurredAt: new Date('2024-06-01T00:00:00Z'),
    externalId: `flow-ext-${txSeq}`,
    swapGroupId: null,
    transferGroupId: null,
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

function makeService(rows: HoldingTransaction[]): ExternalFlowService {
  Container.set(HoldingTransactionRepository, {
    findForHoldingsInRange: async () => rows,
  } as unknown as HoldingTransactionRepository);
  Container.set(HoldingRepository, {
    findByIds: async () => [{ id: HOLDING, tokenId: USD }],
  } as unknown as HoldingRepository);
  Container.set(PriceGraphService, {
    buildPriceLookup: async () => ({ covers: () => false }),
    convert: async (amount: Decimal) => ({ amount: new Decimal(amount), stale: false }),
  } as unknown as PriceGraphService);
  const instance = new ExternalFlowService();
  Container.set(ExternalFlowService, instance);
  return instance;
}

const SCOPE = [{ holdingId: HOLDING, weight: new Decimal(1) }];

describe('ExternalFlowService — a fee answer (SC-888)', () => {
  test('the fee share does not cross the boundary; the rest does', async () => {
    const svc = makeService([
      withdrawal({
        quantity: '-4000',
        transferReview: TRANSFER_REVIEW_SPLIT,
        transferReviewSplit: [
          { decision: 'untracked', quantity: '3500' },
          { decision: 'fee', quantity: '500' },
        ],
      }),
    ]);
    const series = await svc.forHoldings(SCOPE, USD, FROM, TO);
    expect(series.flows).toHaveLength(1);
    // -3500, not -4000. The 500 the bank took stays in the value series as a
    // cost rather than being attributed to the owner's pocket.
    expect(series.flows[0]?.baseAmount).toBe('-3500');
    expect(series.flows[0]?.quantity).toBe('-3500');
  });

  test('the same row with no fee answer is the whole amount', async () => {
    // The control. Without it a service that returned -3500 for every
    // withdrawal would pass the test above, and the number under test is a
    // subtraction — the one shape where a broken reader looks right.
    const svc = makeService([withdrawal({ quantity: '-4000', transferReview: 'untracked' })]);
    const series = await svc.forHoldings(SCOPE, USD, FROM, TO);
    expect(series.flows[0]?.baseAmount).toBe('-4000');
  });

  test('a withdrawal answered `fee` end to end contributes no flow at all', async () => {
    const svc = makeService([withdrawal({ quantity: '-12.40', transferReview: 'fee' })]);
    const series = await svc.forHoldings(SCOPE, USD, FROM, TO);
    expect(series.flows).toHaveLength(0);
    // And it is not counted as a row nothing could value, which is a different
    // and much louder claim about the same absence (SC-149).
    expect(series.unvaluedCount).toBe(0);
  });

  test('a fee larger than the row it sits on zeroes the flow, never reverses it', async () => {
    // `transferReviewSplitSchema` cannot see the transaction, so it cannot
    // refuse this; the row can also have been shrunk by a re-import after the
    // answer was written. Either way the sign must not flip — an outflow that
    // became an inflow is a contribution the owner never made.
    const svc = makeService([
      withdrawal({
        quantity: '-100',
        transferReview: TRANSFER_REVIEW_SPLIT,
        transferReviewSplit: [
          { decision: 'fee', quantity: '400' },
          { decision: 'untracked', quantity: '100' },
        ],
      }),
    ]);
    const series = await svc.forHoldings(SCOPE, USD, FROM, TO);
    expect(series.flows).toHaveLength(0);
  });
});
