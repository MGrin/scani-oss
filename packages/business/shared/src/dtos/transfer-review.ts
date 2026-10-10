import { z } from 'zod';
import { Decimal } from '../decimal';

/**
 * The transfer-review contract (SC-150).
 *
 * Background, because the shape only makes sense against it: an outflow that
 * `LinkTransferPairsUseCase` cannot pair to an inflow is treated by
 * `CostBasisService` as an exit from the portfolio and realized at market
 * value. That is a taxable event and a realized gain the user never made, and
 * the error only ever points one way — a missed pairing invents a gain, it can
 * never invent a loss. Whether moving your own coins from an exchange to your
 * own wallet counts as a sale therefore depends on whether a nightly job
 * matched two rows within ±1% and ±30 minutes.
 *
 * The fix is not a better heuristic. It is asking.
 */

/**
 * The matcher's own tolerances, in the one place both sides can read.
 *
 * They live here rather than in `@scani/domain` because the review surface's
 * job is to *explain* them — "outside the 30-minute window we match on" — and
 * an explanation with its own copy of the number goes quietly wrong the first
 * time somebody tunes one. `packages/business/domain/src/lib/transfer-matching.ts`
 * imports these; nothing redefines them.
 */
export const TRANSFER_MATCH_WINDOW_MS = 30 * 60 * 1000;
export const TRANSFER_MATCH_WINDOW_LABEL = '30-minute';
export const TRANSFER_QTY_EPSILON = 0.01;

/** The most deposits one withdrawal may be paired with (SC-1365). */
export const TRANSFER_MAX_COMBINED_ARRIVALS = 3;

export const TRANSFER_REVIEW_DECISIONS = [
  'paired',
  'internal',
  'left_control',
  'untracked',
  'fee',
] as const;

/**
 * The answer that says a charge was taken out of the money that left (SC-888).
 *
 * ## The two answers it replaces, and why both are false
 *
 * A 4,000 withdrawal where 3,500 arrived and 500 was the bank's fee had two
 * spellings before this and neither is a charge. `left_control` makes
 * `CostBasisService` price the 500 at market and book a REALISED GAIN on money
 * the bank took. `untracked` says "still yours, somewhere Scani cannot see",
 * which is the one thing it demonstrably is not.
 *
 * ## Why it writes no ledger row, unlike the declared path (SC-857)
 *
 * A `fee` portion is a carve-out BY CONSTRUCTION: `splitSumMatches` refuses a
 * split that does not sum to the outflow's own quantity, so the 500 is already
 * inside the -4,000 the importer wrote. A `kind='fee'` row beside it would be
 * the same money twice — `OpeningBalanceReconciliationService` computes
 * `holdings.balance - sum(quantity)` over every row with no kind filter, so it
 * would synthesize a phantom `opening_balance` on the source holding for
 * exactly the fee, and `BalanceAtTimeService` would double-count it in the
 * value series the returns engine is weighed against.
 *
 * The difference from SC-857 is OWNERSHIP, not taste. A declared transfer owns
 * its source anchor — the owner states what LEFT — so it may write two rows
 * that sum to the delta it moved. The queue owns neither the imported row nor
 * the anchor behind it, and restating an importer's quantity is a claim only
 * the importer can make. So the carve-out is the split.
 *
 * ## How the charge reaches the return figure without a row
 *
 * `flowRoleOf('fee')` is `return` — value the portfolio CONSUMED — and
 * `ExternalFlowService` drops a `return` row from the external flows entirely,
 * which is what makes a fee reduce the return instead of reading as a
 * withdrawal. A fee PORTION gets the same rule one level finer: its share of
 * the row is excluded from that row's external flow. See `feePortionOf`.
 *
 * ## What it is NOT
 *
 * Not a linking decision — see `TRANSFER_LINKING_DECISIONS`. A fee never takes
 * the `transfer_group_id`, because a second row on one group id hands
 * `CostBasisService`'s inflow branch a second `transfer_in` to feed after
 * `pending.delete(tgid)` has already run, which is SC-150.
 *
 * Not an answer the MANUAL edit path offers either — see
 * `MANUAL_OUTFLOW_DESTINATIONS`. There a fee is `feeQuantity`, a real carved
 * `kind='fee'` row, for the ownership reason above.
 */
export const TRANSFER_REVIEW_FEE: TransferReviewDecision = 'fee';

/**
 * The `holding_transactions.kind` values the review queue asks the question
 * about — and therefore the only kinds an answer is ever owed for.
 *
 * The definition lives here rather than in `@scani/domain/lib/transfer-matching`
 * (which now re-exports it as `OUTFLOW_KINDS`) because the *realized ledger*
 * needs it, and the ledger reads it twice: once on the server, deciding what a
 * row's `answerSource` is, and once in the browser, deciding whether to say
 * anything about it. A second list in the frontend is the drift this file
 * exists to prevent — `transfer_review` semantics have one home.
 *
 * A `sell` or a `swap_out` is a disposal on its kind alone: nobody is asked
 * whether it left the portfolio, because the transaction already says so. That
 * is why they are absent, and it is the same reason they never appear in the
 * queue.
 */
export const ANSWERABLE_OUTFLOW_KINDS = ['withdraw', 'transfer_out'] as const;

/**
 * Is a `transfer_review` answer owed about this kind at all? (SC-402)
 *
 * The predicate rather than the set at each call site, because the three
 * readers that need it phrase the same test three different ways — an
 * `inArray` in SQL, an `includes` on a widened tuple, a negation in a repair —
 * and the one that got written as neither is how this became a bug:
 * `disposalAnswerSourceOf` read `transfer_review` with no kind test, so a
 * `swap_out` that still carried a stale answer was stamped `unattributed` and
 * the realized ledger rendered *"Recorded as having left your portfolio, so
 * this gain was booked. There is no record of anyone answering it."* Both
 * halves are false about a swap: the gain was booked because it IS a swap, and
 * no answer is owed.
 */
export function answerIsOwedFor(kind: string): boolean {
  return (ANSWERABLE_OUTFLOW_KINDS as readonly string[]).includes(kind);
}

/**
 * The two answers that link the outflow to a holding via `transfer_group_id`.
 *
 * They share the column, and the column is singular — which is why at most one
 * portion of a split may carry either of them. See rule 3 on
 * `transferReviewSplitSchema`.
 */
const TRANSFER_LINKING_DECISIONS = ['paired', 'internal'] as const;

export function isLinkingDecision(decision: TransferReviewDecision): boolean {
  return (TRANSFER_LINKING_DECISIONS as readonly string[]).includes(decision);
}

/**
 * `holding_transactions.source` on the inflow an `internal` answer writes, and
 * the marker that makes the answer reversible (SC-187).
 *
 * Reopening an `internal` answer must delete the row it created, or the next
 * answer double-counts the arrival. The created row is found by
 * `(source, external_id)` where `external_id` is the **outflow's transaction
 * id** — a natural key that survives the group id being cleared, that makes
 * the write idempotent under the `(holding_id, source, external_id)` unique
 * constraint, and that says in the data itself which question produced it.
 */
export const TRANSFER_REVIEW_CREATED_SOURCE = 'transfer-review';

export const transferReviewDecisionSchema = z.enum(TRANSFER_REVIEW_DECISIONS);

export type TransferReviewDecision = (typeof TRANSFER_REVIEW_DECISIONS)[number];

/**
 * The marker `holding_transactions.transfer_review` carries when the answer is
 * more than one of the three above (SC-181).
 *
 * It is deliberately NOT a member of `TRANSFER_REVIEW_DECISIONS`: nobody taps
 * "split", and no branch of `CostBasisService` may treat it as an outcome. It
 * means "the answer is in `transfer_review_split`, go and read it", and it
 * exists so the queue predicate — `transfer_review IS NULL` — keeps working
 * unchanged. A split row is answered; it leaves the queue; the count still
 * reaches zero.
 */
export const TRANSFER_REVIEW_SPLIT = 'split';

/**
 * The most portions one outflow can be divided into.
 *
 * One per answer, because a portion per answer is the whole of what can be
 * said — two portions carrying the same decision are one portion written
 * twice, and `transferReviewSplitSchema` rejects them. The *reachable* maximum
 * is one lower than this, since `paired` and `internal` both need the single
 * `transfer_group_id` column and only one of them can have it.
 *
 * It rose to five with `fee` (SC-888), and deliberately by counting the
 * decisions rather than by a literal: a division into "3,500 paired, 400 left
 * my control, 100 untracked, 500 a fee" is four true statements about one
 * withdrawal, and a cap written as a number is the thing that would have
 * silently refused the fourth.
 */
export const MAX_TRANSFER_REVIEW_PORTIONS = TRANSFER_REVIEW_DECISIONS.length;

export const transferDestinationRefSchema = z.object({
  accountId: z.string().uuid(),
  /** `null` = create a holding for this token in that account. */
  holdingId: z.string().uuid().nullable(),
});

export type TransferDestinationRef = z.infer<typeof transferDestinationRefSchema>;

/**
 * Where a manual balance EDIT says the money went, asked in the same breath as
 * what the edit meant (SC-606).
 *
 * ## Not a new question — the queue's question, moved earlier
 *
 * Measured on a dev stack 2026-08-25: one edit of a manual USD savings holding
 * from 4,000 to 2,000 produced **three** prompts — the cause dialog, then a
 * transfer-review item for the `withdraw` that answer wrote, then a
 * balance-gap item for the interval that row was dated outside of. Answering
 * was what created the next question. The queue is right for a row that
 * arrived from an import, where nobody has been asked; it is wrong on the
 * manual path, where the person is present and has just spoken.
 *
 * ## Why three of the five, and why each exclusion is structural
 *
 * `paired` is missing because it means "this is the same money as that
 * inflow" and needs an inflow row to point at. At edit time no candidate
 * search has run and there is nothing to show, so offering it would be
 * offering an answer that cannot be given. Somebody whose arrival was
 * imported separately still reaches `paired` through the queue, where the
 * candidates exist.
 *
 * `fee` is missing for a different reason, and it is not that a hand edit
 * cannot have one — it is that this path already says it better. The owner
 * states what LEFT, so the edit owns its own anchor and can carve the charge
 * into a real `kind='fee'` row: that is `feeQuantity` below, and it is the
 * shape the importers already write. The queue's `fee` answer exists because
 * the queue owns neither the imported row nor the anchor behind it and can
 * only classify a share of what is already there (SC-888).
 *
 * Asked only for a NEGATIVE delta. `answerIsOwedFor` is `withdraw` and
 * `transfer_out`, so a deposit has no second prompt to pre-empt and asking
 * about one would ADD the question this exists to remove.
 *
 * Declared as a subset of `TRANSFER_REVIEW_DECISIONS` rather than as its own
 * four strings, and it lives beside them for the reason the file already
 * gives about `ANSWERABLE_OUTFLOW_KINDS`: a second vocabulary that happens to
 * agree today is free to disagree tomorrow, and the disagreement would render
 * as a queue asking about a row somebody has already settled.
 */
export const MANUAL_OUTFLOW_DESTINATIONS = [
  'internal',
  'left_control',
  'untracked',
] as const satisfies readonly TransferReviewDecision[];

export type ManualOutflowDestination = (typeof MANUAL_OUTFLOW_DESTINATIONS)[number];

export const manualOutflowDestinationSchema = z.enum(MANUAL_OUTFLOW_DESTINATIONS);

/**
 * The whole of what a manual outflow edit can say about its destination.
 *
 * `internal` carries a destination and the other two do not, checked here
 * rather than at the writer: `TransferReviewService.resolve` THROWS on an
 * `internal` with no destination, and a throw out of a balance edit would
 * leave the user with a 500 over a form they filled in correctly except for a
 * field the client failed to send.
 */
export const manualOutflowAnswerSchema = z
  .object({
    decision: manualOutflowDestinationSchema,
    destination: transferDestinationRefSchema.optional(),
    feeQuantity: z
      .string()
      .refine((v) => isPositiveDecimal(v), {
        message: 'A fee needs an amount greater than zero',
      })
      .optional(),
  })
  .refine((value) => value.decision !== 'internal' || value.destination !== undefined, {
    message: 'An "internal" destination answer must name the holding the money went to',
    path: ['destination'],
  })
  .refine((value) => value.feeQuantity === undefined || value.decision === 'internal', {
    message: 'Only a transfer to another holding of yours can carry a fee',
    path: ['feeQuantity'],
  });

export type ManualOutflowAnswer = z.infer<typeof manualOutflowAnswerSchema>;

/**
 * Is a stated fee small enough to be PART of the movement it was charged on?
 *
 * Strictly smaller, not merely no larger: a fee equal to the whole movement
 * leaves nothing to transfer, and a declared transfer of zero is not a
 * transfer. Larger still would flip the withdrawal's sign.
 *
 * One definition, read by the form (which disables the button) and by
 * `ManualBalanceEditService` (which refuses the write) — the same arrangement
 * `splitSumMatches` has, and for the same reason: two spellings of one rule
 * are free to disagree, and the disagreement renders either as a button that
 * cannot be pressed over a valid answer or as a 500 over a form that looked
 * complete.
 *
 * Both arguments are unsigned magnitudes in the token's own units. A value
 * that is not a decimal at all answers `false`, so an unparseable fee is
 * refused rather than treated as zero.
 */
export function feeFitsMovement(fee: string | Decimal, movement: string | Decimal): boolean {
  try {
    const f = new Decimal(fee);
    const m = new Decimal(movement);
    if (!f.isFinite() || !m.isFinite()) return false;
    return f.gt(0) && f.lt(m.abs());
  } catch {
    return false;
  }
}

const transferDestinationRelevanceSchema = z.enum(['holds_token', 'same_network', 'other']);

export type TransferDestinationRelevance = z.infer<typeof transferDestinationRelevanceSchema>;

/** Best first — the order `destinationsFor` sorts by and the picker renders in. */
export const TRANSFER_DESTINATION_RELEVANCE_ORDER: readonly TransferDestinationRelevance[] = [
  'holds_token',
  'same_network',
  'other',
];

/**
 * A destination as the picker shows it.
 *
 * `source` and `balance` are on the row because they are how a person tells
 * two same-token holdings in the same account apart — the name and the symbol
 * are identical, and "6,217.15, manual" versus "1,201.50, imported" is the
 * whole of the distinction.
 */
const transferDestinationSchema = z.object({
  accountId: z.string().uuid(),
  holdingId: z.string().uuid().nullable(),
  accountName: z.string(),
  institutionName: z.string().nullable(),
  source: z.string().nullable(),
  /** Current balance as a Decimal string, or null when no holding exists. */
  balance: z.string().nullable(),
  /**
   * Will answering `internal` here leave this destination's balance holding
   * the money? (SC-856)
   *
   * True where nobody else states that balance, which is where `writeInflow`
   * moves it — and, on a row with no holding yet, where the destination opens
   * AT the moved amount rather than at zero for a sync to correct.
   * False where a balance sync owns the figure: the arrival is already in it
   * and moving it would count the money twice.
   *
   * It is here rather than derived on the client because the client cannot
   * derive it. `source` tells it whether the HOLDING is hand-curated; whether
   * an hourly sync owns the ACCOUNT is a question about wallets and
   * credentials, and a second implementation of that rule would let the
   * sentence over the button describe a write that does something else.
   */
  movesBalance: z.boolean(),
  /** Which band this row ranks in — see the enum above. */
  relevance: transferDestinationRelevanceSchema,
});

export type TransferDestination = z.infer<typeof transferDestinationSchema>;

/**
 * One share of an outflow, and what happened to it.
 *
 * `quantity` is unsigned and in the token's own units — the same units as the
 * amount on the row being answered, because that is the number on the reader's
 * screen. A 4,000 USD withdrawal split 3,500 / 500 is two portions of 3500 and
 * 500, not a percentage and not a base-currency amount: converting either way
 * would make the sum the user is being asked to check depend on a price
 * lookup.
 */
const transferReviewSplitPortionSchema = z.object({
  decision: transferReviewDecisionSchema,
  /** Positive Decimal string. Zero is not a portion — it is the portion not
   *  being used, which is expressed by leaving it out. */
  quantity: z.string().refine((v) => isPositiveDecimal(v), {
    message: 'Each part needs an amount greater than zero',
  }),
  /** Required on the `paired` portion, meaningless on the others. */
  matchTransactionId: z.string().uuid().optional(),
  /** Required on the `internal` portion, meaningless on the others. */
  destination: transferDestinationRefSchema.optional(),
});

export type TransferReviewSplitPortion = z.infer<typeof transferReviewSplitPortionSchema>;

/**
 * A whole answer, divided.
 *
 * Four rules, all enforced here rather than in the form, because a split that
 * does not add up is a new way to be wrong about money and the form is not the
 * only caller:
 *
 * 1. **At least two portions.** One portion is a whole answer and must be
 *    written as one, or the same state has two representations and every
 *    reader has to handle both.
 * 2. **Several `internal` portions, one per destination holding** (SC-1665,
 *    feeds E2 #23723). Every linking portion shares the outflow's one
 *    `transfer_group_id`, and `CostBasisService` hands each arrival its pro-rata
 *    share of the group's buffer (SC-1365), so a withdrawal spread across two
 *    tracked accounts is answerable. Until SC-1665 this refused a second
 *    linking portion, when the first arrival still took every buffered lot.
 *    Two portions on one holding stay refused: that is one arrival written
 *    twice. A `null` holding counts as its account's, because both portions
 *    would open the same holding there.
 *
 *    **The refusal may NOT name a substitute (SC-874).** An earlier message
 *    ended *"the rest has to be a disposal or untracked"*, and a reader who
 *    followed it recorded money they still hold as SOLD.
 * 3. **Each other decision at most once**, `paired` included: several
 *    deposits for one withdrawal are a whole `paired` answer (SC-1365). See
 *    `MAX_TRANSFER_REVIEW_PORTIONS`.
 * 4. **A linking portion carries its target**: `paired` its deposit,
 *    `internal` its destination. Without one there is nothing to write the
 *    group id on, so the portion is not a smaller version of a valid answer —
 *    it is an unwritable one.
 * 5. **The sum is checked against the transaction**, which this schema cannot
 *    see. `splitSumMatches` does it, at the API boundary and in the form.
 */
export const transferReviewSplitSchema = z
  .array(transferReviewSplitPortionSchema)
  .min(2, { message: 'A split needs at least two parts' })
  .max(MAX_TRANSFER_REVIEW_PORTIONS)
  .superRefine((portions, ctx) => {
    const destinations = new Set<string>();
    for (const portion of portions) {
      if (portion.decision !== 'internal' || !portion.destination) continue;
      const { accountId, holdingId } = portion.destination;
      const key = holdingId ?? `new:${accountId}`;
      if (destinations.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'One part per destination: two parts moved to the same holding are one move. Enter it once with the combined amount.',
        });
        return;
      }
      destinations.add(key);
    }
    const seen = new Set<TransferReviewDecision>();
    for (const portion of portions) {
      if (portion.decision === 'internal') continue;
      if (seen.has(portion.decision)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Each outcome can only appear once in a split',
        });
        return;
      }
      seen.add(portion.decision);
    }
    const pairedIndex = portions.findIndex((p) => p.decision === 'paired');
    if (pairedIndex >= 0 && !portions[pairedIndex]?.matchTransactionId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Pairing part of a transfer requires the matching deposit',
        path: [pairedIndex, 'matchTransactionId'],
      });
    }
    const internalIndex = portions.findIndex((p) => p.decision === 'internal' && !p.destination);
    if (internalIndex >= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Moving part of a transfer requires the holding it moved to',
        path: [internalIndex, 'destination'],
      });
    }
  });

export type TransferReviewSplit = z.infer<typeof transferReviewSplitSchema>;

/**
 * Does this split account for exactly the transaction it answers?
 *
 * Exact, on Decimal, with no tolerance. A tolerance here would be a second
 * matcher — the thing SC-150 exists to stop trusting — and the amount is
 * arithmetic the reader can do: the form shows what is left to allocate and
 * offers the remainder as a tap, so hitting the total by hand is one number
 * typed, not two.
 */
export function splitSumMatches(split: TransferReviewSplit, quantity: string): boolean {
  return splitTotal(split).eq(new Decimal(quantity).abs());
}

/**
 * How much of an outflow its answer calls a FEE, in the token's own units
 * (SC-888).
 *
 * One definition, read by `CostBasisService` (which must not realize a gain on
 * it) and by `ExternalFlowService` (which must not count it as value crossing
 * the portfolio boundary). Two spellings of "how much of this was a charge"
 * would render as a return figure and a cost-basis walk disagreeing about the
 * same row, with nothing on the screen saying which one is wrong.
 *
 * Takes the row's own fields rather than a parsed split, because the two
 * callers reach it from different shapes and the whole-row answer — the entire
 * withdrawal was a bank charge — is as real as the divided one.
 *
 * `quantity` is the row's, unsigned, and it is the CAP: `outflowPortions`
 * already treats the transaction as the authority on how much left and the
 * split as the authority on what happened to it, so a split left stale by a
 * re-import that shrank the row can never claim more than the row holds.
 * Anything unparseable is zero — a fee that cannot be read is not a fee that
 * can be charged.
 */
export function feeShareOf(review: string | null, split: unknown, quantity: string): Decimal {
  let cap: Decimal;
  try {
    cap = new Decimal(quantity).abs();
  } catch {
    return new Decimal(0);
  }
  if (!cap.isFinite() || cap.lte(0)) return new Decimal(0);
  if (review === TRANSFER_REVIEW_FEE) return cap;
  if (review !== TRANSFER_REVIEW_SPLIT) return new Decimal(0);
  const parsed = transferReviewSplitSchema.safeParse(split);
  if (!parsed.success) return new Decimal(0);

  // Walk the portions in order and take what is LEFT, exactly as
  // `outflowPortions` does. A fee written third in a split whose earlier
  // portions already exhaust a shrunken row gets nothing, which is the same
  // answer the walk gives it.
  let remaining = cap;
  for (const portion of parsed.data) {
    if (remaining.lte(0)) break;
    const want = new Decimal(portion.quantity).abs();
    const taken = Decimal.min(want, remaining);
    remaining = remaining.minus(taken);
    if (portion.decision === TRANSFER_REVIEW_FEE) return taken;
  }
  return new Decimal(0);
}

/** The portions' sum, unsigned. Exported for the form's "left to allocate". */
export function splitTotal(split: readonly TransferReviewSplitPortion[]): Decimal {
  return split.reduce((sum, p) => sum.add(new Decimal(p.quantity).abs()), new Decimal(0));
}

export const ANSWER_SOURCES = ['user', 'rule', 'repair', 'unattributed'] as const;

export type AnswerSource = (typeof ANSWER_SOURCES)[number];

/**
 * The value `holding_transactions.transfer_review_source` carries when a
 * standing rule wrote the answer (SC-380).
 *
 * A named constant because it is read as three different claims in three
 * places and they have to be the same string: the answered list attributes the
 * answer to a rule, the write gate refuses to touch a row that already carries
 * ANY source, and the per-row undo tests for it to decide whether to leave the
 * exemption marker behind.
 */
export const RULE_ANSWER_SOURCE = 'rule';

export const RULE_ASSERTED_DECISION: TransferReviewDecision & BulkTransferDecision = 'left_control';

/**
 * The sources a *writer* may claim. `unattributed` is missing on purpose: it is
 * a conclusion drawn from the absence of a record, so nothing can assert it.
 */
export const ANSWER_ATTRIBUTIONS = ['user', 'repair'] as const;

export type AnswerAttribution = (typeof ANSWER_ATTRIBUTIONS)[number];

export function answerSourceOf(row: { transferReviewSource: string | null }): AnswerSource {
  if (row.transferReviewSource === RULE_ANSWER_SOURCE) return 'rule';
  if (row.transferReviewSource === 'repair') return 'repair';
  if (row.transferReviewSource === 'user') return 'user';
  return 'unattributed';
}

/**
 * Could a person have answered this row? The conservative reading, for writers.
 *
 * ## Why this is a second function and not the first one reused
 *
 * `answerSourceOf` and the repair guards shared one predicate — every guard
 * read `answerSourceOf(tx) === 'user'` — and the two want opposite things from
 * the same uncertainty. A DISPLAY must not claim the user answered when it
 * cannot tell. A WRITER must not overrule a person, so it must refuse in
 * exactly the case the display refuses to assert.
 *
 * Sharing one predicate meant the display's fallback silently doubled as the
 * writers' safety margin. Making the display honest without this would have
 * handed three repairs a licence they never had: the 27 stamped-but-unsourced
 * rows would move from `user` (refuse) to `unattributed` (act), and a repair
 * would start rewriting rows that may well be a person's answer with the stamp
 * lost — which is worse than mislabelling them, because it is unrecoverable.
 *
 * So the refusal set is **identical to the one in force before SC-673**, and
 * this function exists to keep it that way while the label above it changes.
 * It is deliberately not `answerSourceOf(row) !== 'repair' && !== 'rule'` —
 * that would also refuse the unstamped rows the repairs were written for
 * (SC-324's 560), silently narrowing what they can fix.
 */
export function mayBeUserAnswer(row: {
  transferReviewSource: string | null;
  transferReviewedAt: Date | null;
}): boolean {
  if (answerSourceOf(row) === 'user') return true;
  // Unattributed AND stamped: something answered at a known moment and left no
  // name. Not evidence a person did — and not evidence one did not.
  return row.transferReviewSource === null && row.transferReviewedAt !== null;
}

/**
 * Why a repair is refusing, in the caller's own verb.
 *
 * Beside the predicate rather than in each repair, because the message states
 * the predicate: three copies would let one of them keep saying "a person
 * answered" about a row where that is exactly what nobody can establish. The
 * refusal is the same in both cases; only the evidence behind it differs, and
 * the reader deciding whether to override needs to know which one they have.
 */
export function unstampedAnswerRefusal(
  row: { transferReviewSource: string | null; transferReviewedAt: Date | null },
  verb: 'overrule' | 'withdraw'
): string {
  return answerSourceOf(row) === 'user'
    ? `answered by a person — this repair does not ${verb} a stamped answer`
    : `carries a review timestamp with no source, so it may be a person's answer — this repair does not ${verb} one`;
}

/**
 * Who took the answer OFF this row, when it carries none (SC-378).
 *
 * The state it reads is `transfer_review IS NULL AND transfer_review_source IS
 * NOT NULL`, which no ordinary path produces: `resolve` and `resolveSplit`
 * always write a decision alongside the source, and `reopen` — the user
 * withdrawing their own answer — nulls both. So a source surviving a null
 * decision means something cleared the answer and left its name.
 *
 * A function rather than the comparison inlined at the call site, because the
 * rule is a conjunction over two columns and the half that gets forgotten is
 * always the first one: reading the source alone would report `repair` on
 * every row a repair has ever *answered*.
 *
 * **`'user'` became reachable in SC-380 and means one specific thing: the
 * reader took back an answer a RULE gave.** `reopen` leaves the source null
 * when it withdraws an answer the user themselves wrote — the row is then
 * exactly as unanswered as one nobody ever answered — and leaves `'user'` when
 * it withdraws a rule's, because that is the marker the rule engine's write
 * gate reads to never answer this row again. So the value is not decoration:
 * it IS the per-row undo, and a reader seeing it is being told why the
 * standing rule about this destination stopped applying here.
 */
export function answerWithdrawnBy(row: {
  transferReview: string | null;
  transferReviewSource: string | null;
}): AnswerAttribution | null {
  if (row.transferReview !== null) return null;
  return (ANSWER_ATTRIBUTIONS as readonly string[]).includes(row.transferReviewSource ?? '')
    ? (row.transferReviewSource as AnswerAttribution)
    : null;
}

/**
 * What a person can say about an outflow they have already answered — the
 * "Answered" half of the queue (SC-181).
 *
 * Deliberately thinner than `PendingTransferReview`: no candidate search and
 * no price lookup, both of which are per-row round trips that the pending list
 * pays because the reader is about to make a judgement with them. Here the
 * reader is looking for a row they already decided, and the only action is to
 * reopen it — after which it is a pending row and carries everything again.
 */
const answeredTransferReviewSchema = z.object({
  transactionId: z.string().uuid(),
  holdingId: z.string().uuid(),
  tokenSymbol: z.string(),
  accountName: z.string(),
  institutionName: z.string().nullable(),
  kind: z.string(),
  quantity: z.string(),
  occurredAt: z.string(),
  counterparty: z.string().nullable(),
  /** One of `TRANSFER_REVIEW_DECISIONS`, or `TRANSFER_REVIEW_SPLIT`. */
  decision: z.string(),
  /** Present only on a split row. */
  split: transferReviewSplitSchema.nullable(),
  /** When the caller answered it. Null exactly when `answerSource` is
   *  `unattributed` — read that instead of testing this for null. */
  reviewedAt: z.string().nullable(),
  answerSource: z.enum(ANSWER_SOURCES),
  ruleNote: z.string().nullable(),
  /**
   * This row is a transfer the OWNER declared, so reopening it UNDOES the
   * movement rather than returning it to the queue (SC-618).
   *
   * On the wire because the confirmation is written before the action, and
   * without it the reader is told the wrong thing about their own money:
   * `reopenConsequence` maps `paired` to "settles nothing and unsettles
   * nothing", which is true of a pairing the queue made and false of one the
   * owner declared — that one moved both anchors, and withdrawing it moves
   * them back.
   *
   * It cannot be derived from `decision`, which is `paired` for both shapes.
   * See `declaredPairLegs` for what actually separates them.
   */
  declared: z.boolean(),
  /**
   * This answer had to CREATE the holding it deposited into, so reopening it
   * removes that holding as well as the arrival (SC-631).
   *
   * On the wire for the same reason as `declared`: the confirmation is written
   * before the action, and `reopenConsequence` otherwise promises "no balance
   * changes either way" over a reopen that takes a position off an account.
   * That sentence is true of a destination that already existed and has never
   * been true of one this answer opened.
   *
   * It cannot be derived from anything else the row carries. `decision` is
   * `internal` for both shapes and `holdingId` is the SOURCE's holding, not
   * the destination's. The fact lives on the arrival row's `source_metadata`
   * — see `created-destination.ts` for why there and not on the holding.
   *
   * FALSE and ABSENT are different, and this boolean is the false one: an
   * arrival row written before SC-631 records nothing either way, and reads
   * here as `false` because the copy it selects is the one that promises
   * least. The reader is never told a holding will be removed when the
   * service would decline to remove it.
   */
  createdDestination: z.boolean(),
});

export type AnsweredTransferReview = z.infer<typeof answeredTransferReviewSchema>;

function isPositiveDecimal(value: string): boolean {
  try {
    const d = new Decimal(value);
    return d.isFinite() && d.gt(0);
  } catch {
    return false;
  }
}

/**
 * `ReviewItem.kind` for the transfer queue. Like
 * `DOCUMENT_EXTRACTION_REVIEW_KIND` and for the same reason, it is not a
 * member of `REVIEWABLE_JOB_NAMES`: an unpaired transfer is not a job. The
 * `transfer-linking` cron that would have paired it completes successfully
 * every night — completing is precisely what it does when it gives up on a
 * row — so keying this off job state would report a queue of zero while the
 * queue has contents.
 */
export const TRANSFER_REVIEW_KIND = 'transfer-review';

/**
 * Why the matcher would not take a candidate on its own. This is the field
 * that makes the surface reviewable rather than merely a list: "we are unsure"
 * is not something a person can act on, and "the amounts differ by 3.4%,
 * outside the ±1% we allow for network fees" is.
 *
 * Ordered by how close the candidate came, because that is the order a reader
 * wants them in.
 *
 * - `matches` — it matched and nothing else did. The matcher left it for a
 *   person because it may not decide alone: the deposit was typed by hand, or
 *   the two accounts sit in different entities (SC-1364).
 * - `ambiguous` — it matched, and so did something else. The matcher's own
 *   comment is right that auto-linking the wrong one corrupts cost basis worse
 *   than not linking at all; this is the case it was written for.
 * - `quantity_outside_tolerance` — right time, wrong amount. Usually a fee
 *   larger than the ±1% allowance, which is what an expensive chain or a
 *   fixed-fee withdrawal looks like.
 * - `time_outside_window` — right amount, too far apart. A CEX withdrawal held
 *   for manual approval, or a bridge that took hours.
 * - `both_outside` — neither matched, and it is only on the list because
 *   nothing better is. Shown last, and never pre-selected.
 */
export const TRANSFER_CANDIDATE_REASONS = [
  'matches',
  'ambiguous',
  'quantity_outside_tolerance',
  'time_outside_window',
  'both_outside',
] as const;

const transferCandidateReasonSchema = z.enum(TRANSFER_CANDIDATE_REASONS);

export type TransferCandidateReason = (typeof TRANSFER_CANDIDATE_REASONS)[number];

/** One side of a possible pair: an inflow that might be the same money. */
const transferCandidateSchema = z.object({
  transactionId: z.string().uuid(),
  holdingId: z.string().uuid(),
  /** Where it landed, in the words the rest of the app uses. */
  accountName: z.string(),
  institutionName: z.string().nullable(),
  /**
   * The candidate's OWN symbol, which is not always the outflow's (SC-336).
   * A bridge's two legs are two token rows — USDC on mainnet and USDC on Base
   * — and until this field existed the surface had only the outflow's symbol
   * to label a candidate with, so a cross-chain arrival would have been
   * described in the words of the thing it is not.
   */
  tokenSymbol: z.string(),
  kind: z.string(),
  /** Unsigned, as a Decimal string — the row's own precision, not a float. */
  quantity: z.string(),
  occurredAt: z.string(),
  reason: transferCandidateReasonSchema,
  /**
   * Signed, as a percentage of the outflow: `+3.4` means the inflow is 3.4%
   * larger. The sign carries information a magnitude does not — an inflow
   * *smaller* than the outflow is the ordinary fee-shaped difference, and a
   * larger one is not, so it deserves a second look.
   */
  quantityDeltaPct: z.number(),
  /** Signed milliseconds: positive when the inflow landed after the outflow. */
  timeDeltaMs: z.number(),
  /** True when this candidate is inside the matcher's own ±1% / ±30min box —
   *  i.e. it would have been auto-linked had it been the only one. */
  withinStrictTolerance: z.boolean(),
});

export type TransferCandidate = z.infer<typeof transferCandidateSchema>;

/**
 * Deposits on ONE holding that together are the withdrawal (SC-1365) — 4,000
 * that the owner recorded as it landed, 3,000 and then 1,000. No single part
 * is near enough to be a candidate on its own, so without this the queue
 * offered only the answer that writes the 4,000 a second time.
 */
const transferCandidateCombinationSchema = z.object({
  holdingId: z.string().uuid(),
  accountName: z.string(),
  institutionName: z.string().nullable(),
  tokenSymbol: z.string(),
  /** The parts' total, unsigned, as a Decimal string. */
  quantity: z.string(),
  /** Signed percentage of the outflow, as on a single candidate. */
  quantityDeltaPct: z.number(),
  /** In the order they landed. */
  parts: z
    .array(
      z.object({
        transactionId: z.string().uuid(),
        quantity: z.string(),
        occurredAt: z.string(),
      })
    )
    .min(2),
});

export type TransferCandidateCombination = z.infer<typeof transferCandidateCombinationSchema>;

const TRANSFER_REVIEW_RULE_VERDICTS = ['not_a_disposal', 'ask_me', 'always_a_disposal'] as const;

/**
 * Whether this verdict is the one that WRITES.
 *
 * A function rather than an equality at each call site because the question is
 * asked in three places that must agree — the authoring refusal, the eager
 * apply, and the rules list's choice of which number to show — and the string
 * it compares is the one value in this file that books capital gains.
 */
export function ruleAssertsDisposal(verdict: string): boolean {
  return verdict === 'always_a_disposal';
}

export const transferReviewRuleVerdictSchema = z.enum(TRANSFER_REVIEW_RULE_VERDICTS);

export type TransferReviewRuleVerdict = (typeof TRANSFER_REVIEW_RULE_VERDICTS)[number];

/** The longest note a rule may carry. Long enough for a sentence, short enough
 *  to render on one row of a list. */
export const TRANSFER_REVIEW_RULE_NOTE_MAX = 200;

export const transferReviewRuleNoteSchema = z
  .string()
  .trim()
  .min(1)
  .max(TRANSFER_REVIEW_RULE_NOTE_MAX);

/**
 * One standing rule, as the rules list shows it.
 *
 * `matchCounterparty` is the whole key, never a truncated display form: the
 * reader revoking a rule has to be able to tell it from a lookalike, which is
 * the same reason the authoring dialog shows all of it. For a chain transfer
 * that is all 42 characters; for a payment rail it is the recipient the rail
 * named, with the per-payment amount stripped (SC-381).
 */
const transferReviewRuleSchema = z.object({
  id: z.string().uuid(),
  matchCounterparty: z.string(),
  verdict: transferReviewRuleVerdictSchema,
  note: z.string(),
  createdAt: z.string(),
  affectedCount: z.number().int(),
  /**
   * How many transfers this rule has ANSWERED and still owns — always 0 for the
   * two verdicts that write nothing (SC-380).
   *
   * A second number rather than a per-verdict meaning for `affectedCount`,
   * because they count opposite sets and the reader needs both at once. An
   * `always_a_disposal` rule that has done its work has `affectedCount` 0 —
   * nothing left waiting — and that is indistinguishable from a rule that
   * matched nothing at all, which is the exact failure `affectedCount` was
   * added to make visible (SC-381).
   *
   * It is also the number the revoke confirmation has to quote. Revoking stops
   * the rule from answering anything further; it does not un-answer what it
   * already did, and a reader who assumed otherwise would leave N booked
   * disposals behind believing they had undone them.
   */
  answeredCount: z.number().int(),
});

export type TransferReviewRule = z.infer<typeof transferReviewRuleSchema>;

/**
 * What marking this destination *"always a disposal"* would do, in money,
 * before it is done (SC-380).
 *
 * This is the confirmation the slice turns on. Every other rule verdict is
 * reversible by revocation with nothing written, so a consequence line was
 * enough; this one books capital gains on transfers the reader has not looked
 * at, and a confirmation that could only say "some transfers" would be asking
 * them to authorize an amount nobody had computed.
 *
 * The numbers come from `bulkPreview` — the same pass SC-382's bulk apply
 * confirms with, against the same `marketValue` the queue's own "if it was a
 * sale" column shows — so the figure quoted here is one the reader has already
 * seen per row.
 */
const ruleMarkPreviewSchema = z.object({
  /** The string the rule would be written on, normalized. Null when this
   *  transfer names no destination, which is when `create` refuses. */
  counterpartyKey: z.string().nullable(),
  /** Transfers that would be answered `left_control` right now. */
  affectedCount: z.number().int(),
  /** What those transfers would book as proceeds. Null when no price could be
   *  resolved for any of them. */
  proceedsInBase: z.string().nullable(),
  /** Of `affectedCount`, how many have no price on their day and so book
   *  nothing — counted rather than folded in as zero. */
  unpricedCount: z.number().int(),
  baseCurrencyCode: z.string(),
  /**
   * Why this destination cannot be marked, when it cannot be.
   *
   * `own_wallet` is the SC-350 refusal raised one level: ten `left_control`
   * answers on addresses in the reader's own `user_wallets` booked 10,500 of
   * disposals on money that never left the portfolio, and a standing rule is
   * that same mistake with a repeat count on it.
   */
  refusal: z.enum(['no_counterparty', 'own_wallet', 'duplicate']).nullable(),
});

export type RuleMarkPreview = z.infer<typeof ruleMarkPreviewSchema>;

/**
 * The rule an `ask_me` match puts on a pending row.
 *
 * Deliberately carried on the row rather than looked up by the client: the
 * pairing "row → rule" is recomputed from the same predicate that produced it,
 * every read, so it can never go stale against a revoked rule.
 */
const matchedTransferRuleSchema = z.object({
  ruleId: z.string().uuid(),
  note: z.string(),
  /**
   * Which sentence the rule is (SC-380).
   *
   * `ask_me` was the only verdict that could reach a pending row before, so the
   * surface could assume it. It cannot now: a row an `always_a_disposal` rule
   * WOULD have answered still appears here when the reader has taken that
   * answer back on it, and telling them "your note about this destination"
   * while withholding "and a rule marks it a disposal, but not this one any
   * more" is the misreading worth a field to prevent.
   */
  verdict: transferReviewRuleVerdictSchema,
});

/**
 * A transfer a `not_a_disposal` rule is keeping out of the queue.
 *
 * Thin like `AnsweredTransferReview` and for the same reason — no candidate
 * search, no price lookup — but it exists for a different one: **a row a rule
 * removed must be visible somewhere rather than vanished.** A queue that
 * silently drops rows is indistinguishable from one that lost them, and the
 * hidden list is also where the undo is proved: revoke the rule and every row
 * here goes straight back to being pending, because nothing was ever written
 * to it.
 */
const hiddenTransferReviewSchema = z.object({
  transactionId: z.string().uuid(),
  holdingId: z.string().uuid(),
  tokenSymbol: z.string(),
  accountName: z.string(),
  institutionName: z.string().nullable(),
  kind: z.string(),
  quantity: z.string(),
  occurredAt: z.string(),
  counterparty: z.string().nullable(),
  /** The rule that is hiding it, so the row can say who removed it. */
  ruleId: z.string().uuid(),
  ruleNote: z.string(),
});

export type HiddenTransferReview = z.infer<typeof hiddenTransferReviewSchema>;

/** An unpaired outflow, with everything needed to judge it. */
const pendingTransferReviewSchema = z.object({
  transactionId: z.string().uuid(),
  holdingId: z.string().uuid(),
  tokenSymbol: z.string(),
  tokenName: z.string().nullable(),
  accountName: z.string(),
  institutionName: z.string().nullable(),
  kind: z.string(),
  quantity: z.string(),
  occurredAt: z.string(),
  counterparty: z.string().nullable(),
  /**
   * The key a rule authored from this row would be written on, and matched by
   * (SC-381).
   *
   * A separate field from `counterparty` because after normalization they are
   * different strings, and the reader has to be shown the one that will
   * actually do the work. `counterparty` is what this transfer says —
   * `Pay 500.00 USD to Teodor Vance (Dividends)` — and it belongs on the row
   * because it names the payment. The key is `teodor vance (dividends)`, and
   * it is what "make a rule about this" means: the next payment, at the next
   * amount, to the same person.
   *
   * Showing only `counterparty` in the authoring dialog would be the SC-375
   * containment saying the wrong sentence. The point of copying the key off
   * the caller's own row rather than accepting a typed one is that the reader
   * confirms what they are ruling on; a dialog that shows a string the rule is
   * not keyed on confirms nothing.
   *
   * Null on the production outflows that name no destination at any layer —
   * a large share of them — which is exactly when `rules.create` refuses.
   */
  counterpartyKey: z.string().nullable(),
  description: z.string().nullable(),
  /**
   * What realizing this row at market value would book as a gain, in the
   * user's base currency — `null` when no price can be resolved at
   * `occurredAt`, which is its own kind of answer.
   *
   * It is the reason to care, so it is on the row rather than behind a tap:
   * without it the queue is a list of chores, and with it the reader can see
   * that answering the top three items is most of the error.
   */
  marketValueInBase: z.string().nullable(),
  baseCurrencyCode: z.string(),
  explorerTxUrl: z.string().nullable(),
  explorerAddressUrl: z.string().nullable(),
  counterpartyIsOwnWallet: z.boolean(),
  /**
   * The `ask_me` rule this row's destination matches, or null (SC-375).
   *
   * Present on a row that is still being asked about — a `not_a_disposal`
   * match removes the row from this list entirely and it appears in
   * `listHiddenByRule` instead. So this field is never a claim that the
   * question was answered; it is the note the reader wrote about an address
   * they will not recognise, shown at the moment they are being asked to
   * recognise it.
   */
  matchedRule: matchedTransferRuleSchema.nullable(),
  /**
   * Set when this row is in the queue because a REPAIR took an earlier answer
   * off it, rather than because nobody has answered it yet (SC-378).
   *
   * The seven rows it was built for were answered `paired` against an arrival
   * on the SAME holding — a movement that did not happen, offered as a
   * candidate by a matcher that no longer would. Withdrawing the answer is
   * Scani's to do because Scani asked the question, but a question that comes
   * back with no explanation reads as the queue losing an answer, which is
   * exactly the thing that stops a careful reader answering at all.
   *
   * It is read off `transfer_review_source` being set while `transfer_review`
   * is null — a state no other writer produces — so it needs no column of its
   * own and it clears itself the moment the row is answered again.
   *
   * Null is the ordinary case: never answered, or the user reopened it
   * themselves, which needs no notice because they did it.
   */
  answerWithdrawnBy: z.enum(ANSWER_ATTRIBUTIONS).nullable(),
  candidates: z.array(transferCandidateSchema),
  combinations: z.array(transferCandidateCombinationSchema),
});

export type PendingTransferReview = z.infer<typeof pendingTransferReviewSchema>;

export const BULK_TRANSFER_DECISIONS = ['left_control', 'untracked'] as const;

export type BulkTransferDecision = (typeof BULK_TRANSFER_DECISIONS)[number];

export const bulkTransferDecisionSchema = z.enum(BULK_TRANSFER_DECISIONS);

/**
 * The answers a row may ALREADY carry and still be bulk-writable — the
 * containment the whole feature rests on.
 *
 * `null` (never answered), `left_control` and `untracked` are exactly the
 * answers that write nothing but the review columns: no `transfer_group_id` on
 * either leg, no deposit row created. So moving a row between any two of them
 * is a pure column write, and moving it *back* is the same write again. That is
 * what makes the undo below exact rather than best-effort.
 *
 * `paired`, `internal` and `split` are excluded from the SOURCE side for the
 * same reason they are excluded from the target side: undoing them means
 * deleting a deposit and clearing a group id from two rows, which is `reopen`'s
 * job and is a per-row decision. It is also the pair of gates SC-378 deadlocked
 * on — `unlinkPair` refuses a reviewed row, `reopen` refuses an unreviewed one
 * — and a bulk path that never enters that state cannot be caught between them.
 */
export const BULK_ELIGIBLE_ANSWERS = [null, 'left_control', 'untracked'] as const;

export function isBulkEligibleAnswer(decision: string | null): boolean {
  return (BULK_ELIGIBLE_ANSWERS as readonly (string | null)[]).includes(decision);
}

export const MAX_BULK_TRANSFER_ROWS = 500;

/**
 * One row and what it is being told to say.
 *
 * `decision: null` means "put it back in the queue", and it exists for exactly
 * one caller: **the undo.** `bulkResolve` returns the answer it replaced on
 * every row it wrote, and undoing is that list handed straight back. It is not
 * offered as a bulk action of its own, deliberately — of the outflows answered
 * `left_control` in bulk, none has a plausible inbound to pair with even under
 * a ±10% / ±7-day net, so a "put these back in the queue" button hands the
 * reader rows with no candidates and the same question they already answered
 * (SC-186, folded into SC-382). Re-answering is the operation with value;
 * un-answering is only ever the way back from a tap just taken.
 */
const bulkTransferEntrySchema = z.object({
  transactionId: z.string().uuid(),
  decision: bulkTransferDecisionSchema.nullable(),
});

export type BulkTransferEntry = z.infer<typeof bulkTransferEntrySchema>;

export const bulkTransferEntriesSchema = z
  .array(bulkTransferEntrySchema)
  .min(1)
  .max(MAX_BULK_TRANSFER_ROWS)
  // One row, one instruction. The same id twice carrying two answers is not a
  // batch to resolve in some order — it is a caller that does not know what it
  // is asking for, and picking a winner would make the outcome depend on
  // array position.
  .refine((entries) => new Set(entries.map((e) => e.transactionId)).size === entries.length, {
    message: 'Each transfer can only appear once',
  });

/**
 * Why a selected row cannot be written, per row.
 *
 * Named rather than counted because a bulk write that quietly drops rows is the
 * defect this whole area keeps producing. The reader is told which row, and
 * why, before anything is written — and the write itself is all-or-nothing, so
 * "12 selected" and "12 written" are never different numbers.
 *
 * - `gone` — not this user's, not an outflow, or a zero-quantity row (the
 *   address-poisoning corpus, which `pendingPredicate` also excludes).
 * - `linked` — it carries a `transfer_group_id`. Either the matcher paired it,
 *   or a `paired`/`internal` answer did. **This gate is load-bearing and is not
 *   implied by the answer column**: a minority of production's unanswered
 *   outflows carry a group id, they are invisible to the queue, and `CostBasisService`
 *   reads `transferGroupId` BEFORE `isConfirmedDisposal` — so a `left_control`
 *   written onto one would book nothing while reading as answered.
 * - `answered_otherwise` — it carries `paired`, `internal` or `split`. `detail`
 *   is that answer. Reopening it is a per-row decision with its own undo.
 * - `own_wallet` — a `left_control` target whose destination is an address in
 *   the caller's own `user_wallets`. `detail` is the address. The same refusal
 *   `resolve` gives (SC-365), applied before a batch can give it twelve times.
 */
const BULK_TRANSFER_REFUSALS = ['gone', 'linked', 'answered_otherwise', 'own_wallet'] as const;

const bulkTransferRefusalSchema = z.object({
  transactionId: z.string().uuid(),
  reason: z.enum(BULK_TRANSFER_REFUSALS),
  /** The answer in the way, or the wallet address. Null when the reason says
   *  everything — `gone` and `linked` have nothing to add. */
  detail: z.string().nullable(),
});

export type BulkTransferRefusal = z.infer<typeof bulkTransferRefusalSchema>;

/**
 * What a bulk apply would do, **in money** — the thing the confirmation shows.
 *
 * A bulk `left_control` books N capital gains on one tap, which makes it the
 * most consequential control in the product. A confirmation that says "12
 * transfers" asks the reader to trust a count; the number that lets them check
 * is the one the ledger will move by, and it is not derivable on the client for
 * the answered list — `AnsweredTransferReview` carries no price, on purpose.
 *
 * So the figure is computed server-side, over the same rows the write will
 * take, by the same `PriceReader` series `listPending` uses for the "if it
 * was a sale" column. The confirmation and the write cannot disagree about
 * which rows they are about, because they are handed the same list.
 */
const bulkTransferPreviewSchema = z.object({
  /** The rows that would be written, in the order they were asked about. */
  eligible: z.array(z.string().uuid()),
  refusals: z.array(bulkTransferRefusalSchema),
  baseCurrencyCode: z.string(),
  /**
   * Market value at each eligible transfer's own moment, summed — what a
   * `left_control` target books as proceeds. Null when nothing is priceable,
   * which is a different claim from zero.
   */
  proceedsInBase: z.string().nullable(),
  /** Eligible rows with no price on their day. They book nothing either way,
   *  and they are why the total above can be an understatement. */
  unpricedCount: z.number().int(),
  /**
   * The eligible rows that ALREADY carry `left_control`, and their share of
   * the proceeds above.
   *
   * The other direction of the same sentence: answering these `untracked`
   * takes that much realized gain back OFF the ledger. A confirmation that
   * only ever describes what is being added would say nothing at all about the
   * operation SC-186 asked for, which is re-answering 219 rows that already
   * book a disposal.
   */
  alreadyDisposedCount: z.number().int(),
  alreadyDisposedInBase: z.string().nullable(),
});

export type BulkTransferPreview = z.infer<typeof bulkTransferPreviewSchema>;

/** One row that was written, and the answer it used to carry. Handed straight
 *  back to `bulkResolve` to undo the batch. */
const bulkTransferAppliedSchema = z.object({
  transactionId: z.string().uuid(),
  previous: bulkTransferDecisionSchema.nullable(),
});

export type BulkTransferApplied = z.infer<typeof bulkTransferAppliedSchema>;

/**
 * The batch, reversed — `bulkResolve`'s output turned back into its input.
 *
 * A function rather than a `.map` at each call site because the two shapes
 * differ by one field name and nothing catches the confusion at runtime: an
 * entry whose `decision` is `undefined` is not rejected, it is read as `null`,
 * so a hand-written undo silently puts every row back in the queue instead of
 * restoring the answers it replaced. That is the wrong write in the one place
 * the feature exists to make reversible.
 */
export function undoEntriesFor(applied: readonly BulkTransferApplied[]): BulkTransferEntry[] {
  return applied.map((row) => ({ transactionId: row.transactionId, decision: row.previous }));
}
