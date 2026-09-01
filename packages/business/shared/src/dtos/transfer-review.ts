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

/**
 * What a person can say about an unpaired outflow. Four answers, no snooze:
 * a queue that can be deferred is a queue that is never emptied, and the whole
 * value here is that the count reaching zero means something.
 *
 * - `paired` — "this is the same money as that inflow". Writes a shared
 *   `transfer_group_id` on both legs, so the lots carry across accounts intact
 *   instead of being retired here and re-opened at market value over there.
 *   This is the answer that actually improves cost basis.
 * - `internal` — "it moved to that holding of mine, and nothing imported the
 *   arrival". Same destination as `paired` and the same shared
 *   `transfer_group_id`; the difference is that there is no inflow row to
 *   point at, so this one **writes it** (SC-187). See
 *   `TRANSFER_REVIEW_CREATED_SOURCE`.
 * - `left_control` — it really did leave the portfolio: sold off-platform,
 *   gifted, spent. Realizing at market is correct for this row — the change is
 *   that somebody chose it.
 * - `untracked` — still the user's money, in an account Scani cannot see (a
 *   cold wallet, an exchange we have no key for). Not a disposal, so nothing
 *   is realized.
 *
 * `internal` exists because the three above assume the destination is either
 * *pairable* or *outside Scani*, and the reported case is neither: money moved
 * to a Revolut account the user keeps up to date by hand. Nothing imports for
 * it, so the matcher was never failing to find the counterpart — there was
 * nothing to find. Every other answer is false about that row, and one of them
 * (`left_control`) books a gain nobody made.
 *
 * There is deliberately no "not sure" value. Not answering is already
 * representable — it is `NULL` — and it is the state the row is in.
 */
export const TRANSFER_REVIEW_DECISIONS = [
  'paired',
  'internal',
  'left_control',
  'untracked',
] as const;

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
export const TRANSFER_LINKING_DECISIONS = ['paired', 'internal'] as const;

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
 */
export const MAX_TRANSFER_REVIEW_PORTIONS = TRANSFER_REVIEW_DECISIONS.length;

/**
 * Where an `internal` answer says the money went (SC-187).
 *
 * The destination is a **holding**, not an account, and that is not a detail.
 * Production has one Airwallex account carrying two USD holdings — one
 * imported, one manual, balances 1,201.50 and 6,217.15 — and a withdrawal that
 * moved between them. An account-level destination cannot express that: both
 * candidates are "Airwallex", same currency, and the reader has no way to say
 * which.
 *
 * `holdingId` is null for the one case a holding id cannot express: the
 * account tracks no position in this token yet, and answering creates one. The
 * account is always named, so the destination is never ambiguous either way.
 */
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
 * ## Why three of the four, and why the exclusion is structural
 *
 * `paired` is missing because it means "this is the same money as that
 * inflow" and needs an inflow row to point at. At edit time no candidate
 * search has run and there is nothing to show, so offering it would be
 * offering an answer that cannot be given. Somebody whose arrival was
 * imported separately still reaches `paired` through the queue, where the
 * candidates exist.
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
    /**
     * How much of what left was the fee, in the token's own units (SC-857).
     *
     * ## Why a transfer needs a second number at all
     *
     * A wire leaves one amount and arrives as another, and until this field
     * existed the declared path had a single `quantity` that it applied to
     * both legs. That left the owner two ways to record a 251.33 wire that
     * landed 250.00 and both were wrong: enter what left and the destination
     * is overstated, enter what landed and the source is understated.
     * Production took the first and the destination had to be reversed 28
     * minutes later with a `kind='correction'` row.
     *
     * ## Why the FEE and not the arrival amount
     *
     * The owner reads two statements. One says 251.33 left; the other will
     * say 250.00 arrived, tomorrow, if it says anything at all. What they
     * know at the moment of the edit is the charge — it is on the same line
     * as the payment — so asking for the fee asks for the figure in front of
     * them rather than making them subtract two numbers from two sources.
     *
     * It also keeps the sum an identity rather than a check: the rows written
     * always add to the delta the anchor moved by, because the fee is carved
     * OUT of the withdrawal instead of being added beside it.
     * `OpeningBalanceReconciliationService` computes
     * `holdings.balance - sum(real txs)` and synthesizes an `opening_balance`
     * for the difference, so a fee row added beside a full-amount withdrawal
     * would manufacture a phantom opening on that holding.
     *
     * ## Why it is refused on the other two answers
     *
     * `left_control` and `untracked` say the money is no longer here or no
     * longer visible; neither has a second leg for a fee to be the difference
     * between. Refused rather than ignored, for the reason the `internal`
     * rule below already gives: a client that sends one has a bug, and
     * dropping it silently leaves the owner believing they recorded a charge.
     *
     * The amount cannot be checked against the movement here — this schema
     * cannot see it, exactly as `transferReviewSplitSchema` cannot see the row
     * it divides. `ManualBalanceEditService` refuses a fee that consumes the
     * whole movement, where the delta is known.
     */
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

/**
 * How plausible a destination is for THIS token, as three bands (SC-850).
 *
 * A rank, never a guess: it decides what the reader reads first and commits
 * nothing. `holds_token` — this account already tracks the token that moved.
 * `same_network` — it does not, but it sits on the same chain as the account
 * the money left, so it could receive it. `other` — everything else.
 *
 * The reported case is a SOL transfer out whose picker offered an Airwallex
 * account and a Bitcoin wallet above the Solana wallets, in alphabetical
 * order, every row saying "No SOL tracked here yet". Ordering is the only
 * thing here that changes the answer rather than the appearance: the app knows
 * which accounts can hold SOL and was making the reader scan for them.
 */
export const transferDestinationRelevanceSchema = z.enum(['holds_token', 'same_network', 'other']);

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
export const transferDestinationSchema = z.object({
  accountId: z.string().uuid(),
  holdingId: z.string().uuid().nullable(),
  accountName: z.string(),
  institutionName: z.string().nullable(),
  /** `holdings.source` — 'manual', 'import_airwallex', 'blockchain', … Null
   *  when no holding exists yet. */
  source: z.string().nullable(),
  /** Current balance as a Decimal string, or null when no holding exists. */
  balance: z.string().nullable(),
  /**
   * Will answering `internal` here leave this destination's balance holding
   * the money? (SC-856)
   *
   * True where nobody else states that balance, which is where `writeInflow`
   * moves it — and, on a row with no holding yet, where `openingOf` opens the
   * new one AT the moved amount rather than at zero for a sync to correct.
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
export const transferReviewSplitPortionSchema = z.object({
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
 * 2. **At most one LINKING portion** — one `paired` or one `internal`, never
 *    both and never two of either. This is a real limit, not an oversight:
 *    linking writes a shared `transfer_group_id`, that is one column on the
 *    outflow row, and `buildTransferComponents` walks it to decide which
 *    holdings share a lot ledger. Two arrivals on one group id do not need a
 *    second column to go wrong — `CostBasisService`'s inflow branch hands the
 *    FIRST `transfer_in` every buffered lot (`rehome`, then `pending.delete`),
 *    so the second finds nothing buffered and opens a fresh market-value lot.
 *    That is the exact defect SC-150 closed. A withdrawal spread across two
 *    *tracked* destinations is therefore still one question this cannot
 *    answer, and it is honest to refuse it rather than half-record it.
 *
 *    **What the refusal may NOT do is name a substitute (SC-874).** This
 *    message used to end *"the rest has to be a disposal or untracked"*, and a
 *    reader who followed it recorded money they still hold as SOLD — a
 *    disposal writes a realised gain and retires the lot, which then feeds
 *    cost basis and every rollup downstream. The limit is correct; that
 *    instruction was not, and a validator naming the only path it will accept
 *    is read as the product telling you what to do. It states the limit and
 *    the trap now, and prescribes nothing.
 *
 *    **It is checked BEFORE rule 3**, so the fan-out shape reaches it. Two
 *    `internal` portions are two duplicate decisions as well as two links,
 *    and in the other order they were refused with *"Each outcome can only
 *    appear once in a split"* — true, opaque, and silent about the one thing
 *    the reader needs to know.
 *
 *    SC-187 widened what "linking" covers without widening how many there can
 *    be, which is why the rule reads on the pair of decisions rather than on
 *    `paired` alone. `internal` is the same claim reached differently — the
 *    deposit is written rather than found — and it consumes the same column.
 * 3. **Each decision at most once.** See `MAX_TRANSFER_REVIEW_PORTIONS`.
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
    const linking = portions.filter((p) => isLinkingDecision(p.decision));
    if (linking.length > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Only one part of a transfer can move to somewhere Scani tracks — cost basis follows one destination, and two would send it to neither. A second tracked destination cannot be recorded here; recording it as something that left your control would book money you still hold as sold.',
      });
      return;
    }
    const seen = new Set<TransferReviewDecision>();
    for (const portion of portions) {
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
    const internalIndex = portions.findIndex((p) => p.decision === 'internal');
    if (internalIndex >= 0 && !portions[internalIndex]?.destination) {
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

/** The portions' sum, unsigned. Exported for the form's "left to allocate". */
export function splitTotal(split: readonly TransferReviewSplitPortion[]): Decimal {
  return split.reduce((sum, p) => sum.add(new Decimal(p.quantity).abs()), new Decimal(0));
}

/**
 * Where an answer came from (SC-241).
 *
 * `user` is a positive claim and is provable — **from
 * `transfer_review_source`, and from nothing else** (SC-673).
 *
 * This paragraph used to prove it from the TIMESTAMP: *"`transfer_reviewed_at`
 * is written in exactly two places, both inside `TransferReviewService`, both
 * behind an authenticated session … so a stamped row was answered by the
 * caller, in the queue, on that date."* Every clause of that is still true of
 * the application, and the conclusion is still false, because it needs one more
 * premise that was never stated: **that the application is the only writer.**
 *
 * It is not. SC-324 measured 560 answered rows written by something outside it
 * — a hand-run UPDATE, or a version that no longer exists — and rows later
 * acquired timestamps with no source the same way. Measured on production
 * 2026-08-26: 79.6% of observed burn by value decoded as `user`; 23.7% carried
 * a user stamp.
 *
 * The lesson is narrower than "the comment was wrong", because it was not. An
 * argument about what the CODE does cannot establish what is in the DATABASE
 * while anything else can write to it, and the gap does not announce itself —
 * the inference stays sound and quietly stops being true.
 *
 * `unattributed` is the contrapositive and nothing more: **no stamp means the
 * answer was not given through the queue.** It does not say who gave it, and
 * naming these `import` or `machine` would claim a provenance the data does not
 * carry.
 *
 * **What they actually are, measured rather than inferred (SC-324).** This
 * paragraph used to say they were "inserted with `transfer_review` already
 * populated by an import that no longer exists in the tree", and that is
 * disprovable: on 2026-08-17 production held 560 unattributed rows against 1
 * attributed one, 535 of the 560 created on 2026-05-17 with `updated_at =
 * created_at`, and the column itself did not exist until migration 0032 landed
 * on 2026-08-14. Nothing can have been inserted with a column that was three
 * months away. All 535 share one transaction id, committed between 14:31:19Z
 * and 15:00:22Z on 2026-08-14 — bracketed by the `xmin` of neighbouring rows,
 * since the app's own write path sets `updated_at` alongside the answer and
 * these rows' `updated_at` never moved. So: **one raw `UPDATE`, on the day the
 * queue shipped, touching neither timestamp.** Who ran it and on what basis is
 * not in the database, which is the whole of what `unattributed` claims.
 *
 * It is a field rather than a `reviewedAt === null` check at each reader
 * because a nullable timestamp is the exact shape catalogued in
 * `docs/technical/2026-08-15_absence-and-refusal.md`: one value carrying both
 * "nobody answered this" and "we did not record when". The UI dropped it
 * silently for precisely that reason.
 *
 * **`repair` is the third, and it exists because two were not enough (SC-350).**
 * Ten of mgrin's own `left_control` answers sent money to addresses in his own
 * `user_wallets`, booking 10,500 of disposals on money that never left the
 * portfolio; he asked for them to be corrected in production. A correction made
 * ON a user's behalf is neither of the two values above, and both available ways
 * of recording it are false:
 *
 * - **Stamping `transfer_reviewed_at`** would read as `user` — which this file
 *   documents as provable and means "the caller answered it, in the queue, on
 *   that date". He did not; he answered the opposite. It would also erase the
 *   only evidence the ten were ever wrong, leaving the repair indistinguishable
 *   from his own judgement. That is SC-302's 560-row failure exactly: a write
 *   with no attribution, and four investigations to work out who did it.
 * - **Leaving it NULL** would read as `unattributed` — "not given through the
 *   queue, and the database does not say by whom". Here the database can say:
 *   this task, this reasoning, this commit. Filing a deliberate correction next
 *   to the raw UPDATE would discard the one distinction the vocabulary is for.
 *
 * So provenance gets its own column rather than being inferred from a
 * timestamp's nullness — which is the same absence-vs-refusal argument the
 * paragraph above already makes, applied one value further. `transfer_reviewed_at`
 * is still written for a repair, because it is not in dispute: it records WHEN
 * the correction happened, and only `answerSource` claims WHO. The invariant
 * below therefore still holds — `reviewedAt` is null exactly when the source is
 * `unattributed`.
 *
 * A `repair` row is a real answer in every other respect: it leaves the queue,
 * the matcher will not overrule it, and the user can reopen it like any other.
 * The surface says Scani made it and why, so the reader can disagree.
 *
 * **`rule` is the fourth, and it is the only one that is not a person**
 * (SC-380). mgrin marked a destination *"always a disposal"* and the queue,
 * next time it was read, wrote `left_control` on every unanswered transfer to
 * it. That answer is his in the sense that he authorized the standing sentence
 * behind it, and it is emphatically NOT his in the sense the other three
 * values are about: he did not look at this row, and the measurement he
 * accepted when he asked for it says roughly one in twenty-three of them will
 * be wrong — always in the direction of a gain he did not make (SC-345).
 *
 * So it cannot be recorded as `user`, which this file documents as provable
 * and means "the caller answered THIS transfer, in the queue, on that date".
 * It cannot be `repair` either: a repair is Scani correcting a specific answer
 * it can argue about, and this is a rule firing on a row nobody has read. And
 * it must not be `unattributed`, because the provenance here is completely
 * known — there is a rule row, with the user's own note on it, named by
 * `holding_transactions.transfer_review_rule_id`.
 *
 * `transfer_reviewed_at` IS stamped for a rule answer, exactly as it is for a
 * repair: the column records WHEN the answer was written and only
 * `answerSource` claims WHO. The invariant that `reviewedAt` is null exactly
 * when the source is `unattributed` therefore still holds.
 */
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

/**
 * The one answer a rule is allowed to assert, as a value rather than a literal
 * repeated at each writer (SC-380).
 *
 * It is `left_control` and nothing else, because `left_control` is the only
 * decision `isConfirmedDisposal` books — and being able to book a disposal
 * unattended is the entire thing mgrin authorized and the entire risk he
 * accepted. A rule that could assert `paired` or `internal` would need a
 * destination it has no way to know; one that could assert `untracked` would
 * be a second, quieter way to say `not_a_disposal`, which already exists and
 * writes nothing.
 *
 * Deliberately NOT a new member of `TRANSFER_REVIEW_DECISIONS`. Adding one
 * there would silently raise `MAX_TRANSFER_REVIEW_PORTIONS`, which is defined
 * as that list's length, and move the split cap for reasons having nothing to
 * do with splits.
 */
export const RULE_ASSERTED_DECISION: TransferReviewDecision & BulkTransferDecision = 'left_control';

/**
 * The sources a *writer* may claim. `unattributed` is missing on purpose: it is
 * a conclusion drawn from the absence of a record, so nothing can assert it.
 */
export const ANSWER_ATTRIBUTIONS = ['user', 'repair'] as const;

export type AnswerAttribution = (typeof ANSWER_ATTRIBUTIONS)[number];

/**
 * `answerSource` from the ONE column that carries it (SC-673).
 *
 * One function because three readers need the same answer — the answered list,
 * the realized ledger, and any repair that has to check its own work — and
 * three copies of a fallback chain is how the middle value gets forgotten in
 * one of them.
 *
 * ## Why the timestamp is not a parameter
 *
 * It used to be, and the last line read
 * `row.transferReviewedAt === null ? 'unattributed' : 'user'` — so a row with a
 * review timestamp and no source was reported as **the user's own answer**, on
 * no evidence but a date.
 *
 * That was ~99.8% accurate on the day it shipped, and the test pinning it said
 * so: *"the column is NULL on every row that predates it, and adding it must
 * not change one row's provenance."* At the time 560 of 561 answered rows had
 * no timestamp (SC-324), and every write path in the application set both
 * columns together — so *has a timestamp* and *a person answered* were the same
 * predicate about the same rows.
 *
 * Then rows acquired timestamps without sources, and the predicate inverted
 * with nothing to announce it. Measured on production 2026-08-26, over the 79
 * `left_control` rows feeding observed burn: **79.6% of the value read as
 * `user` and 23.7% carried a user stamp.** The 56% difference was this line,
 * guessing, in the user's favour. The timestamps cluster on three dates, which
 * is the signature of bulk writes rather than of a person answering.
 *
 * So the timestamp is gone from the signature rather than merely unread. A
 * narrower parameter is what makes the invariant survive the next author: it
 * cannot be consulted here, whatever tomorrow's data looks like, because it is
 * not in scope. Callers that need to know WHEN a row was answered already hold
 * `transferReviewedAt` and can read it directly — it is a fact about time and
 * was never a fact about authorship.
 *
 * **This does not decide whether a person answered those rows** — SC-324 is
 * explicit that it is not a claim that nobody did. It reports that the database
 * does not say, which is the only thing the database supports. Where a caller
 * must be conservative about that uncertainty rather than merely honest about
 * it, use `mayBeUserAnswer`.
 */
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
export const answeredTransferReviewSchema = z.object({
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
  /**
   * The note on the rule that answered it — present exactly when
   * `answerSource` is `rule` (SC-380).
   *
   * The whole reason `transfer_review_rule_id` is a column. "Answered by a
   * rule" is a provenance; "answered by the rule you wrote saying this is your
   * Bybit deposit address" is the thing a reader can actually check three
   * years later, which is the standard mgrin set when he said of 560 answered
   * transfers that he could not remember them anyway.
   *
   * Survives revocation, because a revoked rule is soft-deleted on purpose: the
   * row it answered is still owed an explanation.
   */
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
  'ambiguous',
  'quantity_outside_tolerance',
  'time_outside_window',
  'both_outside',
] as const;

export const transferCandidateReasonSchema = z.enum(TRANSFER_CANDIDATE_REASONS);

export type TransferCandidateReason = (typeof TRANSFER_CANDIDATE_REASONS)[number];

/** One side of a possible pair: an inflow that might be the same money. */
export const transferCandidateSchema = z.object({
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
 * What a standing rule about a counterparty is allowed to say (SC-375, third
 * verdict added by SC-380).
 *
 * mgrin asked for "a rule about all the transfers to that address", and when
 * the open question was put to him — may a rule ever answer `left_control`
 * unattended? — he chose *"auto-answer, but only on addresses I explicitly
 * mark"*. The first two values below are the default half of that answer and
 * were the whole of SC-375: **neither writes a `transfer_review`.** The third
 * is the marking, and it is the only one that writes anything at all.
 *
 * - `not_a_disposal` — "stop asking me about this address". The row leaves the
 *   pending queue and appears in the hidden list, naming the rule that took it.
 * - `ask_me` — "keep asking, but tell me what this address is". The row stays
 *   in the queue wearing the note, so the same question is asked about an
 *   address the reader can now recognise.
 * - `always_a_disposal` — **the marking** (SC-380). Every unanswered transfer
 *   to this destination is answered `left_control`, attributed to the rule
 *   rather than to the reader, and left individually undoable. The cost is
 *   measured rather than guessed: SC-345 put an address rule at right 111
 *   times in 116 at the disposal-or-not level, and all five errors asserted a
 *   disposal on money that had STAYED — so the mistake runs only toward a gain
 *   he did not make. He took that trade for addresses he marks himself.
 *
 * For the first two the safety property is structural rather than careful. An
 * outflow carrying no review realizes nothing — `isConfirmedDisposal` is
 * `left_control` alone — so those rules change exactly one thing, whether the
 * question is asked, and change no number in the ledger. That is what makes
 * them safe to apply unattended, retroactively, and against a key an attacker
 * can write to (see `transferReviewRules.matchCounterparty`). The third
 * removes that argument by design, and what replaces it is written out in
 * `ruleWritablePredicate` and in SC-380's migration: the key is still never
 * typed, the write gate is `transfer_review_source IS NULL`, and the group-id
 * gate comes along with `pendingPredicate`.
 *
 * **Marking is per-destination and never inferred.** No verdict is a default,
 * nothing derives one from how similar rows were answered before, and
 * `always_a_disposal` is reachable only by choosing it against a consequence
 * line that quotes the money it is about to book (`RuleMarkPreview`).
 *
 * `ask_me` is not a weaker `not_a_disposal`; it is the half of the feature that
 * carries the actual value. SC-345's measurement of the expensive part of this
 * queue is mgrin's own sentence about 560 answered rows — *"I honestly can not
 * remember that anymore anyway"* — so a rule that says "this is the address you
 * told me is your Bybit deposit" answers the expensive half and leaves the tap.
 */
export const TRANSFER_REVIEW_RULE_VERDICTS = [
  'not_a_disposal',
  'ask_me',
  'always_a_disposal',
] as const;

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
export const transferReviewRuleSchema = z.object({
  id: z.string().uuid(),
  matchCounterparty: z.string(),
  verdict: transferReviewRuleVerdictSchema,
  note: z.string(),
  createdAt: z.string(),
  /**
   * How many transfers in this user's queue the rule currently applies to —
   * hidden, for `not_a_disposal`; labelled, for `ask_me`.
   *
   * It is on the rule rather than left to a reader's arithmetic because it is
   * the only way to see what revoking would bring back, and because a rule
   * matching nothing — or matching only the row it was written from — is the
   * failure mode this feature is most likely to have. A rule keyed on the
   * `counterparty` column would today match zero rows in production, and the
   * first real rule anybody wrote matched exactly one row forever (SC-381).
   * Both look identical to a rule with nothing to do.
   */
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
export const ruleMarkPreviewSchema = z.object({
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
export const matchedTransferRuleSchema = z.object({
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

export type MatchedTransferRule = z.infer<typeof matchedTransferRuleSchema>;

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
export const hiddenTransferReviewSchema = z.object({
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
export const pendingTransferReviewSchema = z.object({
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
   * Null on the 202 of 470 production outflows that name no destination at any
   * layer, which is exactly when `rules.create` refuses.
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
  /**
   * The transaction on its chain's block explorer, and the counterparty
   * address on the same one (SC-346). Null for a row with no chain behind it
   * — an exchange withdrawal has no hash to look up — and null rather than a
   * guessed root for a chain we have no explorer for.
   *
   * The queue asks "did this leave your portfolio?" about a row whose only
   * marks are an amount and a date. For a chain transfer that is not enough
   * to remember by: mgrin's answer to 560 of them was that he could not.
   * These two links are what make one identifiable.
   */
  explorerTxUrl: z.string().nullable(),
  explorerAddressUrl: z.string().nullable(),
  /**
   * True when `counterparty` is an address in this user's own `user_wallets` —
   * the one fact that makes the question answerable rather than a guess (SC-350).
   *
   * SC-346 put the destination on the row and mgrin answered ten transfers
   * `left_control` anyway, at 08:27-08:31 on 2026-08-17, forty-four minutes
   * after the address shipped. Every one of them had gone to a wallet he had
   * registered himself. The row was not wrong and it was not missing anything
   * it claimed to show: it showed `0x9d8ae06a94c5592f57812e0f045438602a7e14ab`,
   * and a 42-character hex string is not something a person recognises. He
   * booked 10,500 of disposals on his own money, and `left_control` is the one
   * answer that cannot be un-booked by a later matcher run.
   *
   * `user_wallets` already held the answer and nothing joined it. So the fix is
   * not more address — it is the sentence the address was standing in for.
   *
   * **False is not "this address is a stranger's".** It is "not among the
   * wallets you have registered", which covers a cold wallet he never added and
   * an exchange deposit address alike. So the surface may assert the positive
   * case and must not assert the negative one; see the copy at the call site.
   */
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
});

export type PendingTransferReview = z.infer<typeof pendingTransferReviewSchema>;

/**
 * The answers one tap may give to MANY transfers at once (SC-382).
 *
 * mgrin asked for this directly — *"I want to select multiple transfers and
 * apply the same decision to them"* — and the list is two of the four, not
 * four, because the other two are not harder to build. They are unrepresentable
 * in bulk:
 *
 * - **`paired` names one `matchTransactionId`.** A single deposit cannot be the
 *   other half of twelve withdrawals, and `claimInflow` would refuse the second
 *   through twelfth anyway once the first claimed the inflow. "Apply `paired` to
 *   these twelve" is not an operation with a meaning.
 * - **`internal` names one destination HOLDING.** `listDestinations` is scoped
 *   to the outflow's own token and excludes the holding it left, so a selection
 *   spanning two tokens has no destination that is valid for all of it; and with
 *   `holdingId: null` each row writes a deposit and may open a holding
 *   (SC-187/SC-356). Twelve rows, twelve arrivals, twelve amounts — that is
 *   twelve judgements wearing one tap.
 * - **`split` is quantities in the row's own units** that must sum exactly to
 *   *that row's* quantity. No division is true of two different rows.
 *
 * What is left is the pair that needs nothing from the row but the row itself.
 * They are also, precisely, the two states the ledger can move between with a
 * column write: see `BULK_ELIGIBLE_ANSWERS`.
 */
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

/**
 * The most transfers one apply may write.
 *
 * Above every population this queue has ever had — 74 pending and 219 answered
 * `left_control` in production on 2026-08-18 — and far below anything that
 * makes a single transaction long-running, since the write is at most three
 * `UPDATE … WHERE id = ANY` statements regardless of N.
 */
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
export const bulkTransferEntrySchema = z.object({
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
 *   implied by the answer column**: 29 of production's 236 unanswered outflows
 *   carry a group id, they are invisible to the queue, and `CostBasisService`
 *   reads `transferGroupId` BEFORE `isConfirmedDisposal` — so a `left_control`
 *   written onto one would book nothing while reading as answered.
 * - `answered_otherwise` — it carries `paired`, `internal` or `split`. `detail`
 *   is that answer. Reopening it is a per-row decision with its own undo.
 * - `own_wallet` — a `left_control` target whose destination is an address in
 *   the caller's own `user_wallets`. `detail` is the address. The same refusal
 *   `resolve` gives (SC-365), applied before a batch can give it twelve times.
 */
export const BULK_TRANSFER_REFUSALS = [
  'gone',
  'linked',
  'answered_otherwise',
  'own_wallet',
] as const;

export type BulkTransferRefusalReason = (typeof BULK_TRANSFER_REFUSALS)[number];

export const bulkTransferRefusalSchema = z.object({
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
 * take, by the same `PriceGraphService` call `listPending` uses for the "if it
 * was a sale" column. The confirmation and the write cannot disagree about
 * which rows they are about, because they are handed the same list.
 */
export const bulkTransferPreviewSchema = z.object({
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
export const bulkTransferAppliedSchema = z.object({
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
