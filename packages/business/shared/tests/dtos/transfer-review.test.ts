import { describe, expect, test } from 'bun:test';
import {
  ANSWER_ATTRIBUTIONS,
  ANSWER_SOURCES,
  answerSourceOf,
  answerWithdrawnBy,
  BULK_ELIGIBLE_ANSWERS,
  BULK_TRANSFER_DECISIONS,
  bulkTransferEntriesSchema,
  feeFitsMovement,
  feeShareOf,
  isBulkEligibleAnswer,
  isLinkingDecision,
  MAX_TRANSFER_REVIEW_PORTIONS,
  manualOutflowAnswerSchema,
  mayBeUserAnswer,
  RULE_ANSWER_SOURCE,
  splitSumMatches,
  splitTotal,
  TRANSFER_REVIEW_FEE,
  TRANSFER_REVIEW_SPLIT,
  transferReviewSplitSchema,
  undoEntriesFor,
  unstampedAnswerRefusal,
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
    //
    // Five since `fee` joined the decisions (SC-888). Asserted as a literal on
    // purpose: `MAX_TRANSFER_REVIEW_PORTIONS` is derived from the enum's
    // length, so writing the derivation here would be the schema agreeing with
    // itself and this line would pass whatever the enum became.
    expect(MAX_TRANSFER_REVIEW_PORTIONS).toBe(5);
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
 * What the refusal is allowed to SAY (SC-874).
 *
 * The limit above is sound and stays. What was not sound is that the refusal
 * named a substitute — *"the rest has to be a disposal or untracked"* — and a
 * disposal is not a substitute for a move: it writes a realised gain and
 * retires the lot, so a reader who followed the instruction recorded money
 * they still hold as sold, and cost basis and every rollup downstream
 * inherited it.
 *
 * Two shapes reach the rule and both are checked, because they used to be
 * refused by DIFFERENT rules with different words. A fan-out to two tracked
 * accounts is two `internal` portions, which is two duplicate decisions as
 * well as two links, and it hit `Each outcome can only appear once in a
 * split` first — true, and silent about the only thing the reader needs.
 */
describe('transferReviewSplitSchema — the refusal prescribes nothing', () => {
  const A = {
    accountId: '11111111-2222-4333-8444-555555555555',
    holdingId: '66666666-7777-4888-8999-aaaaaaaaaaaa',
  };
  const B = {
    accountId: '22222222-3333-4444-8555-666666666666',
    holdingId: '77777777-8888-4999-8aaa-bbbbbbbbbbbb',
  };

  const LINKING_SPLITS: ReadonlyArray<readonly [string, unknown]> = [
    [
      'a fan-out to two tracked destinations',
      [
        { decision: 'internal', quantity: '3000', destination: A },
        { decision: 'internal', quantity: '1000', destination: B },
      ],
    ],
    [
      'one leg whose arrival was imported and one that was not',
      [
        {
          decision: 'paired',
          quantity: '3000',
          matchTransactionId: '99999999-8888-4777-8666-555555555555',
        },
        { decision: 'internal', quantity: '1000', destination: B },
      ],
    ],
  ];

  for (const [label, split] of LINKING_SPLITS) {
    test(`${label} is refused, and the refusal names the linking limit`, () => {
      const parsed = transferReviewSplitSchema.safeParse(split);
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues[0]?.message).toContain('Only one part of a transfer can move');
    });

    test(`${label} is not told to book the rest as a disposal`, () => {
      const parsed = transferReviewSplitSchema.safeParse(split);
      expect(parsed.success).toBe(false);
      const message = parsed.error?.issues[0]?.message ?? '';
      expect(message).not.toContain('has to be');
      expect(message).not.toContain('disposal');
    });
  }

  test('a duplicate that is not a link still gets the duplicate message', () => {
    // The linking check runs first now, so this is the control: reordering it
    // must not have swallowed the rule it moved ahead of.
    const parsed = transferReviewSplitSchema.safeParse([
      { decision: 'untracked', quantity: '3000' },
      { decision: 'untracked', quantity: '1000' },
    ]);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toBe('Each outcome can only appear once in a split');
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
/**
 * The fee a declared transfer may state (SC-857).
 *
 * The schema is the half a type cannot check: `feeQuantity` is a string on
 * every answer, and the two things that make it valid — a positive amount, and
 * only on `internal` — are refusals, not shapes. `feeFitsMovement` is the
 * third rule, and it lives here rather than in the schema for the reason
 * `splitSumMatches` does: the schema cannot see the movement.
 */
describe('manualOutflowAnswerSchema — the fee (SC-857)', () => {
  const DESTINATION = { accountId: crypto.randomUUID(), holdingId: crypto.randomUUID() };

  test('an internal answer may carry one', () => {
    const parsed = manualOutflowAnswerSchema.parse({
      decision: 'internal',
      destination: DESTINATION,
      feeQuantity: '1.33',
    });
    expect(parsed.feeQuantity).toBe('1.33');
  });

  test('no fee at all is the common answer and stays valid', () => {
    // The must-be-ABSENT control. Without it every assertion below could be
    // satisfied by a schema that had simply become stricter about everything.
    const parsed = manualOutflowAnswerSchema.parse({
      decision: 'internal',
      destination: DESTINATION,
    });
    expect(parsed.feeQuantity).toBeUndefined();
  });

  test('a zero fee is refused — that is "no fee", written as a number', () => {
    // Zero is the portion not being used, expressed by leaving it out, which
    // is the same rule `transferReviewSplitPortionSchema` states. Admitting it
    // would put a `fee` row of nothing in a ledger somebody reads.
    expect(
      manualOutflowAnswerSchema.safeParse({
        decision: 'internal',
        destination: DESTINATION,
        feeQuantity: '0',
      }).success
    ).toBe(false);
  });

  for (const decision of ['left_control', 'untracked'] as const) {
    test(`a fee on ${decision} is refused rather than ignored`, () => {
      // Neither has a second leg for a fee to be the difference between.
      // Refused, because dropping it silently leaves the owner believing they
      // recorded a charge.
      expect(manualOutflowAnswerSchema.safeParse({ decision, feeQuantity: '1.33' }).success).toBe(
        false
      );
    });
  }
});

describe('feeFitsMovement', () => {
  test('is strict, not merely no-larger', () => {
    // A fee equal to the whole movement leaves nothing to transfer, and a
    // declared transfer of zero is not a transfer.
    expect(feeFitsMovement('1.33', '251.33')).toBe(true);
    expect(feeFitsMovement('251.33', '251.33')).toBe(false);
    expect(feeFitsMovement('251.34', '251.33')).toBe(false);
  });

  test('reads the movement as a magnitude, so a stored outflow works unchanged', () => {
    // Outflow quantities are stored negative and the fee is unsigned — the
    // same asymmetry `splitSumMatches` handles, and the reason the sign is
    // taken off here rather than at each caller.
    expect(feeFitsMovement('1.33', '-251.33')).toBe(true);
    expect(feeFitsMovement('300', '-251.33')).toBe(false);
  });

  test('compares in Decimal, not in floats', () => {
    expect(feeFitsMovement('0.3', '0.30000000000000004')).toBe(true);
    expect(feeFitsMovement('0.1', '0.1')).toBe(false);
  });

  test('an unparseable fee is refused, never treated as zero', () => {
    // The direction matters: reading a bad value as zero would let a garbled
    // field through as "no fee" and the transfer would silently overstate its
    // destination, which is the defect SC-857 is about.
    expect(feeFitsMovement('', '100')).toBe(false);
    expect(feeFitsMovement('abc', '100')).toBe(false);
    expect(feeFitsMovement('-5', '100')).toBe(false);
    expect(feeFitsMovement('1', 'abc')).toBe(false);
  });
});

describe('answerSourceOf', () => {
  /**
   * THE TEST THAT USED TO LIVE HERE PINNED THE BUG, AND ITS REASONING WAS SOUND
   * (SC-673).
   *
   * It read *"a stamped row with no source is `user` — the whole existing
   * corpus"*, justified as: *"the column is NULL on every row that predates it,
   * and adding it must not change one row's provenance."* On the day it was
   * written that was right for all but one row — every answered row but one
   * carried no timestamp (SC-324), and every write path set both columns
   * together, so *stamped* and *a person answered* picked out the same rows.
   *
   * Rows then acquired timestamps without sources and the predicate inverted,
   * silently, because nothing in it was ever a statement about authorship.
   * Measured on production 2026-08-26: most of the observed burn by value read
   * as `user`, while only a fraction of the rows carried a user stamp.
   *
   * Which is why the tests below assert a PROPERTY rather than a corpus. A test
   * written against the shape of today's data is a test that expires when the
   * data moves, and gives no sign that it has.
   */
  test('a stamped row with no source is NOT the user — the timestamp says when, never who', () => {
    expect(answerSourceOf({ transferReviewSource: null })).toBe('unattributed');
  });

  test('an unstamped row with no source is `unattributed`', () => {
    // The 560-row raw UPDATE of 2026-08-14. Not `import` and not `machine`:
    // the database does not say who, and that is the whole claim.
    expect(answerSourceOf({ transferReviewSource: null })).toBe('unattributed');
  });

  test('`repair` and `rule` are reported as themselves', () => {
    expect(answerSourceOf({ transferReviewSource: 'repair' })).toBe('repair');
    expect(answerSourceOf({ transferReviewSource: RULE_ANSWER_SOURCE })).toBe('rule');
  });

  test('`user` requires the source column to say so', () => {
    expect(answerSourceOf({ transferReviewSource: 'user' })).toBe('user');
  });

  /**
   * THE DURABLE ONE. Every test above is about a value; this is about what the
   * function is allowed to look at, and it cannot expire with the data.
   *
   * The signature carries only `transferReviewSource`, so the timestamp is not
   * merely unread — it is out of scope, and restoring the old fallback would
   * have to widen the parameter first. This asserts the consequence anyway, in
   * case someone widens it: an unrecognised source is `unattributed` whatever
   * else is true of the row.
   */
  test('no source value outside the known set is ever promoted to an attribution', () => {
    for (const source of ['', 'import', 'migration', 'USER', 'User', 'sc-380', 'bulk']) {
      expect(answerSourceOf({ transferReviewSource: source })).toBe('unattributed');
    }
  });

  test('nothing can assert `unattributed` — it is a conclusion, not a claim', () => {
    expect(ANSWER_ATTRIBUTIONS).not.toContain('unattributed');
    for (const attribution of ANSWER_ATTRIBUTIONS) {
      expect(ANSWER_SOURCES).toContain(attribution);
    }
  });
});

/**
 * The conservative reading, for writers (SC-673).
 *
 * `answerSourceOf` and the three repair guards shared one predicate, and they
 * want opposite things from the same uncertainty: a display must not CLAIM the
 * user answered when it cannot tell, and a writer must not OVERRULE a person,
 * so it has to refuse in exactly that case.
 *
 * Making the display honest without this would have handed the repairs a
 * licence they never had — the stamped-but-unsourced rows would move from
 * `user` (refuse) to `unattributed` (act), and a repair would begin rewriting
 * rows that may well be a person's answer with the stamp lost. That is worse
 * than mislabelling them, because a rewrite is not recoverable.
 *
 * So the refusal set here is asserted to be IDENTICAL to the one in force
 * before SC-673, on all four shapes.
 */
describe("mayBeUserAnswer — the writers' predicate is unchanged by SC-673", () => {
  const STAMPED = new Date('2026-08-17T00:00:00Z');

  test('a stamped user answer is refused', () => {
    expect(mayBeUserAnswer({ transferReviewSource: 'user', transferReviewedAt: STAMPED })).toBe(
      true
    );
  });

  test('a review timestamp with no source is refused — it MAY be a person', () => {
    // SC-324 is explicit that this is not a claim nobody decided. The display
    // says the database cannot tell; the writer treats that as a reason to stop.
    expect(mayBeUserAnswer({ transferReviewSource: null, transferReviewedAt: STAMPED })).toBe(true);
  });

  test('no source and no timestamp is NOT refused — these are what the repairs exist for', () => {
    // SC-324's 560 rows. Refusing here would silently narrow every repair to
    // nothing, which is the failure mode opposite to the one SC-673 fixes.
    expect(mayBeUserAnswer({ transferReviewSource: null, transferReviewedAt: null })).toBe(false);
  });

  test('a machine-attributed answer is not refused, stamped or not', () => {
    expect(mayBeUserAnswer({ transferReviewSource: 'repair', transferReviewedAt: STAMPED })).toBe(
      false
    );
    expect(
      mayBeUserAnswer({ transferReviewSource: RULE_ANSWER_SOURCE, transferReviewedAt: STAMPED })
    ).toBe(false);
  });

  /**
   * The two functions disagree on exactly one shape, and that disagreement is
   * the entire point of there being two. If they ever agree everywhere, one of
   * them has been rewritten in terms of the other and the guard is gone.
   */
  test('display and writer disagree on precisely the stamped-unsourced row', () => {
    const shapes = [
      { transferReviewSource: 'user', transferReviewedAt: STAMPED },
      { transferReviewSource: null, transferReviewedAt: STAMPED },
      { transferReviewSource: null, transferReviewedAt: null },
      { transferReviewSource: 'repair', transferReviewedAt: STAMPED },
    ];
    const disagreements = shapes.filter(
      (row) => (answerSourceOf(row) === 'user') !== mayBeUserAnswer(row)
    );
    expect(disagreements).toEqual([{ transferReviewSource: null, transferReviewedAt: STAMPED }]);
  });
});

describe('unstampedAnswerRefusal names which evidence it has', () => {
  test("a stamped answer is refused as a person's", () => {
    expect(
      unstampedAnswerRefusal(
        { transferReviewSource: 'user', transferReviewedAt: new Date() },
        'overrule'
      )
    ).toContain('answered by a person');
  });

  test('an unsourced one says so, rather than claiming a person answered', () => {
    const message = unstampedAnswerRefusal(
      { transferReviewSource: null, transferReviewedAt: new Date() },
      'withdraw'
    );
    expect(message).toContain('no source');
    expect(message).toContain('withdraw');
    expect(message).not.toContain('answered by a person');
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

/**
 * The `fee` answer (SC-888).
 *
 * Two properties, and the second is the one a later change is most likely to
 * break without meaning to: a fee must never become a LINKING decision.
 * Linking writes the single `transfer_group_id`, and a second row on one group
 * id hands `CostBasisService`'s inflow branch another `transfer_in` to feed
 * after `pending.delete(tgid)` has run, which is SC-150.
 */
describe('a fee is part of an answer, never a destination', () => {
  test('paired + fee is accepted; paired + internal still is not', () => {
    const matchTransactionId = crypto.randomUUID();
    expect(
      transferReviewSplitSchema.safeParse([
        { decision: 'paired', quantity: '3500', matchTransactionId },
        { decision: 'fee', quantity: '500' },
      ]).success
    ).toBe(true);
    // The control. Both of these want the one `transfer_group_id`; a fee wants
    // none, which is the whole reason the first parse is allowed to pass.
    expect(
      transferReviewSplitSchema.safeParse([
        { decision: 'paired', quantity: '3500', matchTransactionId },
        {
          decision: 'internal',
          quantity: '500',
          destination: { accountId: crypto.randomUUID(), holdingId: null },
        },
      ]).success
    ).toBe(false);
  });

  test('`fee` is not a linking decision', () => {
    expect(isLinkingDecision(TRANSFER_REVIEW_FEE)).toBe(false);
    // Positive control: the predicate is not simply answering `false`.
    expect(isLinkingDecision('paired')).toBe(true);
    expect(isLinkingDecision('internal')).toBe(true);
  });

  test('a fee portion needs no target, unlike the two that link', () => {
    expect(
      transferReviewSplitSchema.safeParse([
        { decision: 'untracked', quantity: '3500' },
        { decision: 'fee', quantity: '500' },
      ]).success
    ).toBe(true);
  });
});

/**
 * `feeShareOf` — how much of an outflow its answer calls a charge (SC-888).
 *
 * One definition, read by the cost-basis walk and by the returns engine. It is
 * the number that decides whether a bank's cut lands in the return figure as a
 * cost or reads as money the owner took out, so the edges matter more than the
 * happy path.
 */
describe('feeShareOf', () => {
  test('reads the fee portion of a split, and zero when there is none', () => {
    const split = [
      { decision: 'untracked', quantity: '3500' },
      { decision: 'fee', quantity: '500' },
    ];
    expect(feeShareOf(TRANSFER_REVIEW_SPLIT, split, '-4000').toString()).toBe('500');
    expect(
      feeShareOf(
        TRANSFER_REVIEW_SPLIT,
        [
          { decision: 'untracked', quantity: '3500' },
          { decision: 'left_control', quantity: '500' },
        ],
        '-4000'
      ).toString()
    ).toBe('0');
  });

  test('a whole answer of `fee` is the whole row', () => {
    expect(feeShareOf(TRANSFER_REVIEW_FEE, null, '-16.85').toString()).toBe('16.85');
  });

  test('an unanswered row has no fee', () => {
    expect(feeShareOf(null, null, '-4000').toString()).toBe('0');
    expect(feeShareOf('left_control', null, '-4000').toString()).toBe('0');
  });

  test('the row is the cap, so a stale split cannot claim more than is there', () => {
    // A re-import that corrected 4,000 down to 600 knows nothing about the
    // answer attached to it. `outflowPortions` treats the transaction as the
    // authority on how much left; this reads the same way, taking what is left
    // after the portions ahead of it.
    const split = [
      { decision: 'untracked', quantity: '3500' },
      { decision: 'fee', quantity: '500' },
    ];
    expect(feeShareOf(TRANSFER_REVIEW_SPLIT, split, '-600').toString()).toBe('0');
    expect(feeShareOf(TRANSFER_REVIEW_SPLIT, split, '-3800').toString()).toBe('300');
  });

  test('an unreadable split or quantity is zero, never a throw', () => {
    // The callers are a cost-basis walk and a returns engine; neither has a
    // sensible response to an exception halfway through a portfolio, and both
    // have one to "no fee was stated".
    expect(feeShareOf(TRANSFER_REVIEW_SPLIT, 'not a split', '-100').toString()).toBe('0');
    expect(feeShareOf(TRANSFER_REVIEW_SPLIT, [{ decision: 'fee' }], '-100').toString()).toBe('0');
    expect(feeShareOf(TRANSFER_REVIEW_FEE, null, 'not a number').toString()).toBe('0');
  });
});
