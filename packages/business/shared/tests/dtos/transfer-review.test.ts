import { describe, expect, test } from 'bun:test';
import {
  ANSWER_ATTRIBUTIONS,
  ANSWER_SOURCES,
  answerSourceOf,
  answerWithdrawnBy,
  BULK_ELIGIBLE_ANSWERS,
  BULK_TRANSFER_DECISIONS,
  bulkTransferEntriesSchema,
  isBulkEligibleAnswer,
  MAX_TRANSFER_REVIEW_PORTIONS,
  splitSumMatches,
  splitTotal,
  TRANSFER_REVIEW_SPLIT,
  transferReviewSplitSchema,
  undoEntriesFor,
} from '../../src/dtos/transfer-review';

/**
 * The contract for a divided answer (SC-181).
 *
 * These rules are tested at the contract rather than in the form because the
 * form is not the only caller: the tRPC boundary parses with this schema, and
 * a split that does not add up is a new way to be wrong about money. The one
 * rule this file cannot check is the sum against the transaction — that needs
 * the row, so it lives in `TransferReviewService`.
 */

const REPORTED = [
  { decision: 'untracked', quantity: '3500' },
  { decision: 'left_control', quantity: '500' },
];

describe('transferReviewSplitSchema', () => {
  test('accepts the reported 3,500 untracked / 500 disposed division', () => {
    expect(transferReviewSplitSchema.safeParse(REPORTED).success).toBe(true);
  });

  test('accepts a three-way division, and nothing wider', () => {
    expect(
      transferReviewSplitSchema.safeParse([
        { decision: 'paired', quantity: '2000', matchTransactionId: crypto.randomUUID() },
        { decision: 'untracked', quantity: '1500' },
        { decision: 'left_control', quantity: '500' },
      ]).success
    ).toBe(true);
    // One portion per decision is the ceiling the array enforces; the
    // *reachable* ceiling is one lower, because `paired` and `internal` share
    // the single `transfer_group_id` column and the linking rule below refuses
    // a division that uses both (SC-187).
    expect(MAX_TRANSFER_REVIEW_PORTIONS).toBe(4);
    expect(
      transferReviewSplitSchema.safeParse([
        { decision: 'paired', quantity: '1000', matchTransactionId: crypto.randomUUID() },
        {
          decision: 'internal',
          quantity: '1000',
          destination: { accountId: crypto.randomUUID(), holdingId: crypto.randomUUID() },
        },
        { decision: 'untracked', quantity: '1500' },
        { decision: 'left_control', quantity: '500' },
      ]).success
    ).toBe(false);
  });

  test('rejects one part — that is a whole answer, and has its own write', () => {
    expect(transferReviewSplitSchema.safeParse([REPORTED[0]]).success).toBe(false);
  });

  test('rejects the same outcome twice, which is one part written twice', () => {
    expect(
      transferReviewSplitSchema.safeParse([
        { decision: 'untracked', quantity: '3500' },
        { decision: 'untracked', quantity: '500' },
      ]).success
    ).toBe(false);
  });

  test('rejects a zero or negative part', () => {
    for (const quantity of ['0', '-500', 'not a number', '']) {
      expect(
        transferReviewSplitSchema.safeParse([
          { decision: 'untracked', quantity: '3500' },
          { decision: 'left_control', quantity },
        ]).success
      ).toBe(false);
    }
  });

  test('a paired part without its deposit is unwritable, not merely incomplete', () => {
    // Pairing writes a shared `transfer_group_id`; without a partner there is
    // nothing to share it with, and the lots would be buffered for an inflow
    // that never arrives.
    expect(
      transferReviewSplitSchema.safeParse([
        { decision: 'paired', quantity: '3500' },
        { decision: 'left_control', quantity: '500' },
      ]).success
    ).toBe(false);
  });
});

describe('splitSumMatches', () => {
  test('holds against the transaction, sign and all', () => {
    const split = transferReviewSplitSchema.parse(REPORTED);
    // Outflow quantities are stored negative; the parts are unsigned.
    expect(splitSumMatches(split, '-4000')).toBe(true);
    expect(splitSumMatches(split, '4000')).toBe(true);
    expect(splitSumMatches(split, '-4000.01')).toBe(false);
  });

  test('is exact — there is no tolerance to fall through', () => {
    // A tolerance here would be a second matcher, which is the thing SC-150
    // exists to stop trusting.
    const split = transferReviewSplitSchema.parse([
      { decision: 'untracked', quantity: '1' },
      { decision: 'left_control', quantity: '0.00000001' },
    ]);
    expect(splitSumMatches(split, '-1.00000001')).toBe(true);
    expect(splitSumMatches(split, '-1.00000002')).toBe(false);
  });

  test('adds in Decimal, not in floats', () => {
    const split = transferReviewSplitSchema.parse([
      { decision: 'untracked', quantity: '0.1' },
      { decision: 'left_control', quantity: '0.2' },
    ]);
    expect(splitTotal(split).toString()).toBe('0.3');
    expect(splitSumMatches(split, '-0.3')).toBe(true);
  });
});

/**
 * The contract for the fourth answer (SC-187).
 *
 * The rule worth the most attention here is the *linking* one. Before SC-187
 * the schema said "at most one `paired` portion", and the reason it gave was
 * about `transfer_group_id` being one column — a reason that applies word for
 * word to `internal`, which writes the same column. Widening the set of
 * answers that link without widening the rule would have re-opened the exact
 * defect SC-150 closed, by a route nobody would think to look down.
 */
describe('transferReviewSplitSchema — moving to a holding Scani tracks', () => {
  const DESTINATION = {
    accountId: '11111111-2222-4333-8444-555555555555',
    holdingId: '66666666-7777-4888-8999-aaaaaaaaaaaa',
  };

  test('accepts the reported case: 3,500 to a manual holding, 500 gone', () => {
    const parsed = transferReviewSplitSchema.safeParse([
      { decision: 'internal', quantity: '3500', destination: DESTINATION },
      { decision: 'left_control', quantity: '500' },
    ]);
    expect(parsed.success).toBe(true);
  });

  test('refuses a move with nowhere to move to', () => {
    const parsed = transferReviewSplitSchema.safeParse([
      { decision: 'internal', quantity: '3500' },
      { decision: 'left_control', quantity: '500' },
    ]);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toContain('the holding it moved to');
  });

  test('accepts a destination whose holding does not exist yet', () => {
    // `holdingId: null` is "that account tracks no position in this token" —
    // a real destination, answered by creating one.
    const parsed = transferReviewSplitSchema.safeParse([
      {
        decision: 'internal',
        quantity: '3500',
        destination: { accountId: DESTINATION.accountId, holdingId: null },
      },
      { decision: 'left_control', quantity: '500' },
    ]);
    expect(parsed.success).toBe(true);
  });

  test('refuses two linking parts — one group id cannot point at two places', () => {
    const parsed = transferReviewSplitSchema.safeParse([
      {
        decision: 'paired',
        quantity: '2000',
        matchTransactionId: '99999999-8888-4777-8666-555555555555',
      },
      { decision: 'internal', quantity: '2000', destination: DESTINATION },
    ]);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toContain('Only one part');
  });
});

/**
 * Where an answer came from, as one function (SC-350).
 *
 * Tested at the contract because THREE readers derive it — the answered queue,
 * the realized ledger and the repair checking its own work — and they used to
 * hold two copies of a fallback chain between them. A third value landing in one
 * of them is how a ledger row and the queue row it came from end up disagreeing
 * about who decided.
 */
describe('answerSourceOf', () => {
  test('a stamped row with no source is `user` — the whole existing corpus', () => {
    // The column is NULL on every row that predates it, and adding it must not
    // change one row's provenance.
    expect(answerSourceOf({ transferReviewSource: null, transferReviewedAt: new Date() })).toBe(
      'user'
    );
  });

  test('an unstamped row with no source is `unattributed`', () => {
    // The 560-row raw UPDATE of 2026-08-14. Not `import` and not `machine`:
    // the database does not say who, and that is the whole claim.
    expect(answerSourceOf({ transferReviewSource: null, transferReviewedAt: null })).toBe(
      'unattributed'
    );
  });

  test('`repair` wins over the timestamp that would otherwise read as `user`', () => {
    // The correction is stamped — WHEN it happened is not in dispute — so
    // deriving from the timestamp alone would forge the user's answer, which is
    // the exact failure this value exists to prevent.
    expect(answerSourceOf({ transferReviewSource: 'repair', transferReviewedAt: new Date() })).toBe(
      'repair'
    );
  });

  test('an explicit `user` source agrees with the timestamp fallback', () => {
    expect(answerSourceOf({ transferReviewSource: 'user', transferReviewedAt: new Date() })).toBe(
      'user'
    );
  });

  test('nothing can assert `unattributed` — it is a conclusion, not a claim', () => {
    expect(ANSWER_ATTRIBUTIONS).not.toContain('unattributed');
    for (const attribution of ANSWER_ATTRIBUTIONS) {
      expect(ANSWER_SOURCES).toContain(attribution);
    }
  });
});

/**
 * The state SC-378 leaves behind, and the half of the rule that is easy to
 * drop.
 *
 * `transfer_review_source` outliving a null `transfer_review` is what says a
 * repair took an answer off this row rather than the user never having given
 * one. Reading the source alone — the obvious shortcut — reports `repair` on
 * every row a repair has ever ANSWERED, which is a different and much larger
 * set, so the first test below is the one that matters.
 */
describe('answerWithdrawnBy', () => {
  test('is null while the row still carries an answer, whatever the source says', () => {
    expect(
      answerWithdrawnBy({ transferReview: 'left_control', transferReviewSource: 'repair' })
    ).toBeNull();
    expect(
      answerWithdrawnBy({ transferReview: 'paired', transferReviewSource: 'user' })
    ).toBeNull();
  });

  test('names the repair that cleared the answer', () => {
    expect(answerWithdrawnBy({ transferReview: null, transferReviewSource: 'repair' })).toBe(
      'repair'
    );
  });

  test('is null for a row nobody has ever answered — the ordinary queue', () => {
    expect(answerWithdrawnBy({ transferReview: null, transferReviewSource: null })).toBeNull();
  });

  test('is null for a value outside the vocabulary rather than passing it through', () => {
    expect(
      answerWithdrawnBy({ transferReview: null, transferReviewSource: 'unattributed' })
    ).toBeNull();
  });
});

/**
 * What may be answered many at a time (SC-382).
 *
 * Pinned at the contract because the list is the feature's whole containment:
 * `left_control` is the only answer that books a disposal, and the three that
 * are missing are missing because they cannot be true of two rows at once, not
 * because nobody got round to them. A later reader adding `internal` here
 * would be adding "mint N holdings on one tap", and the test should be what
 * stops them rather than the comment.
 */
describe('the bulk vocabulary', () => {
  test('offers exactly the two answers that need nothing from the row', () => {
    expect([...BULK_TRANSFER_DECISIONS]).toEqual(['left_control', 'untracked']);
    // `paired` names one deposit, `internal` one destination holding, `split`
    // amounts that sum to one row's quantity.
    expect(BULK_TRANSFER_DECISIONS as readonly string[]).not.toContain('paired');
    expect(BULK_TRANSFER_DECISIONS as readonly string[]).not.toContain('internal');
    expect(BULK_TRANSFER_DECISIONS as readonly string[]).not.toContain(TRANSFER_REVIEW_SPLIT);
  });

  test('will rewrite only the answers that are link-free — never one carrying a group', () => {
    for (const answer of BULK_ELIGIBLE_ANSWERS) expect(isBulkEligibleAnswer(answer)).toBe(true);
    // Each of these owns a `transfer_group_id`, and `internal` also owns a
    // deposit row it wrote. Taking one back is `reopen`'s job, per row.
    for (const answer of ['paired', 'internal', TRANSFER_REVIEW_SPLIT]) {
      expect(isBulkEligibleAnswer(answer)).toBe(false);
    }
  });

  test('refuses the same transfer twice, rather than letting array order decide', () => {
    const twice = [
      { transactionId: '11111111-1111-4111-8111-111111111111', decision: 'left_control' },
      { transactionId: '11111111-1111-4111-8111-111111111111', decision: 'untracked' },
    ];
    expect(bulkTransferEntriesSchema.safeParse(twice).success).toBe(false);
  });

  test('undoEntriesFor turns the write’s output back into its input, field for field', () => {
    // The bug this helper exists to prevent: `previous` read as `decision`
    // yields `undefined`, which is not rejected — it is read as `null`, and
    // every row goes back to the queue instead of back to its old answer.
    expect(
      undoEntriesFor([
        { transactionId: 'a', previous: 'untracked' },
        { transactionId: 'b', previous: null },
      ])
    ).toEqual([
      { transactionId: 'a', decision: 'untracked' },
      { transactionId: 'b', decision: null },
    ]);
  });
});
