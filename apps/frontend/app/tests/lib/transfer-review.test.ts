import '../i18n-preload';

import { describe, expect, test } from 'bun:test';
import type { PendingTransferReview, TransferDestination } from '@scani/shared';
import i18n from 'i18next';
import {
  decisionConsequence,
  destinationDetail,
  destinationGroup,
  destinationScale,
  type SplitDraftRow,
  splitConsequence,
  splitIsCommittable,
  toSplitPortions,
} from '../../src/v3/lib/transfer-review';

const t = i18n.t.bind(i18n);

/**
 * The fourth answer's words and rules (SC-187).
 *
 * These are tested here rather than through the components because they are
 * the product: the sentence a person reads before committing an answer that
 * *writes a transaction into another account* is the last thing between them
 * and a number they cannot see being wrong. Two of the assertions below are
 * about a claim, not a format — that a balance is not moved, and that a
 * holding is being created — and both were absent from the first draft.
 */

const ITEM: PendingTransferReview = {
  counterpartyKey: null,
  explorerTxUrl: null,
  explorerAddressUrl: null,
  counterpartyIsOwnWallet: false,
  matchedRule: null,
  answerWithdrawnBy: null,
  transactionId: '11111111-1111-4111-8111-111111111111',
  holdingId: '22222222-2222-4222-8222-222222222222',
  tokenSymbol: 'USD',
  tokenName: 'US Dollar',
  accountName: 'Business USD',
  institutionName: 'Airwallex',
  kind: 'withdraw',
  quantity: '4000',
  occurredAt: '2026-08-14T10:32:00.000Z',
  counterparty: 'Revolut',
  description: 'Withdrawal',
  marketValueInBase: '4000',
  baseCurrencyCode: 'USD',
  candidates: [],
};

const SAVINGS: TransferDestination = {
  accountId: '33333333-3333-4333-8333-333333333333',
  holdingId: '44444444-4444-4444-8444-444444444444',
  accountName: 'Savings',
  institutionName: 'Revolut',
  source: 'manual',
  balance: '6500.32',
  relevance: 'holds_token',
};

const NO_HOLDING_YET: TransferDestination = {
  accountId: '55555555-5555-4555-8555-555555555555',
  holdingId: null,
  accountName: 'Wise Balance',
  institutionName: 'Wise',
  source: null,
  balance: null,
  relevance: 'other',
};

function rows(overrides: Partial<Record<string, Partial<SplitDraftRow>>> = {}): SplitDraftRow[] {
  return (['paired', 'internal', 'left_control', 'untracked'] as const).map((decision) => ({
    decision,
    amount: '',
    matchTransactionId: null,
    destination: null,
    ...(overrides[decision] ?? {}),
  }));
}

describe('destinationDetail', () => {
  test('renders every balance in one picker at the same scale', () => {
    // The first phone capture read `1,201.5` directly above `6,500.32`. These
    // figures exist to be compared — they are the only thing distinguishing
    // two identically-named holdings — and a column whose decimal points do
    // not line up cannot do that job.
    const airwallex: TransferDestination = { ...SAVINGS, balance: '1201.50', holdingId: 'x' };
    const scale = destinationScale([airwallex, SAVINGS]);
    expect(destinationDetail(airwallex, 'USD', scale)).toBe('1,201.50 USD · manual');
    expect(destinationDetail(SAVINGS, 'USD', scale)).toBe('6,500.32 USD · manual');
  });

  test('says NOTHING about a destination with no holding yet', () => {
    // SC-850. It used to say "No USD tracked here yet — a holding will be
    // created" on EVERY such row, and the production screenshot was a list on
    // which that was every row: one sentence repeated eleven times, which
    // carries no information and pushed the balances that do off the screen.
    // The claim is true of a whole band, so the band's heading makes it once.
    expect(destinationDetail(NO_HOLDING_YET, 'USD', 2)).toBeNull();
    expect(destinationGroup(t, NO_HOLDING_YET, 'USD').groupHint).toBe(
      'No USD tracked here yet — a holding will be created'
    );
  });
});

describe('destinationGroup', () => {
  test('names the band a destination sits in, and only promises a holding where one is created', () => {
    expect(destinationGroup(t, SAVINGS, 'USD')).toEqual({ group: 'Already holds USD' });
    expect(destinationGroup(t, { ...NO_HOLDING_YET, relevance: 'same_network' }, 'SOL')).toEqual({
      group: 'On the same network',
      groupHint: 'No SOL tracked here yet — a holding will be created',
    });
    expect(destinationGroup(t, NO_HOLDING_YET, 'SOL').group).toBe('Your other accounts');
  });
});

describe('decisionConsequence — moved somewhere Scani tracks', () => {
  test('promises the balance is untouched, which is the whole double-count answer', () => {
    const text = decisionConsequence(t, 'internal', ITEM, null, SAVINGS);
    expect(text).toContain('keeps what you originally paid for it');
    expect(text).toContain('Revolut · Savings');
    expect(text).toContain('A deposit of 4,000 USD');
    // The reported user had already raised this balance by hand.
    expect(text).toContain('Its balance stays at 6,500.32 USD');
  });

  test('says a holding is being created, with the balance it will have', () => {
    const text = decisionConsequence(t, 'internal', ITEM, null, NO_HOLDING_YET);
    expect(text).toContain('A new USD holding is created there with a balance of 4,000 USD');
    // Never the balance promise, which would be false here.
    expect(text).not.toContain('stays at');
  });

  test('asks for the destination before it promises anything', () => {
    expect(decisionConsequence(t, 'internal', ITEM, null, null)).toBe(
      'Pick the holding this money moved to.'
    );
  });
});

describe('splitIsCommittable — the reported division', () => {
  test('accepts 3,500 to a tracked holding and 500 gone', () => {
    const draft = rows({
      internal: { amount: '3500', destination: SAVINGS },
      left_control: { amount: '500' },
    });
    expect(splitIsCommittable(draft, ITEM)).toBe(true);
    expect(toSplitPortions(draft)).toEqual([
      {
        decision: 'internal',
        quantity: '3500',
        destination: { accountId: SAVINGS.accountId, holdingId: SAVINGS.holdingId },
      },
      { decision: 'left_control', quantity: '500' },
    ]);
  });

  test('refuses a move with no destination picked', () => {
    const draft = rows({ internal: { amount: '3500' }, left_control: { amount: '500' } });
    expect(splitIsCommittable(draft, ITEM)).toBe(false);
  });

  test('refuses two linking parts, and says why rather than asking for amounts', () => {
    // One `transfer_group_id` column cannot point at two destinations; a
    // second link would leave one of them opening a fresh market-value lot,
    // which is the defect SC-150 closed.
    const draft = rows({
      paired: { amount: '2000', matchTransactionId: 'dep-1' },
      internal: { amount: '2000', destination: SAVINGS },
    });
    expect(splitIsCommittable(draft, ITEM)).toBe(false);
    expect(splitConsequence(t, draft, ITEM, () => null)).toContain('Only one part');
  });
});

describe('splitConsequence — moved somewhere Scani tracks', () => {
  test('names the destination, the deposit and the untouched balance', () => {
    const draft = rows({
      internal: { amount: '3500', destination: SAVINGS },
      left_control: { amount: '500' },
    });
    const text = splitConsequence(t, draft, ITEM, () => null);
    expect(text).toContain('3,500 USD moves to Revolut · Savings');
    expect(text).toContain('a deposit of 3,500 USD is recorded');
    expect(text).toContain('Only the disposal books a gain.');
    expect(text).toContain('No balance is changed.');
  });

  test('does not claim no balance changed when a holding is being created', () => {
    const draft = rows({
      internal: { amount: '3500', destination: NO_HOLDING_YET },
      left_control: { amount: '500' },
    });
    const text = splitConsequence(t, draft, ITEM, () => null);
    expect(text).toContain('A new USD holding is created there');
    expect(text).not.toContain('No balance is changed');
  });
});
