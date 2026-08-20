import { z } from 'zod';
import { ANSWER_SOURCES } from './transfer-review';

/**
 * The realized-PnL ledger contract (SC-152).
 *
 * Realized PnL is a scalar everywhere it is shown — the home chart, the PnL
 * series, `portfolio_value_daily`, both exports — so "why did my realized gain
 * change?" has no answer. Behind the number is a FIFO walk that knows exactly
 * which acquisition lot each disposal consumed, and then discards that the
 * moment it adds to the total. This is that working, kept.
 *
 * **Explicitly not tax output.** `docs/technical/2026-08-14_why-no-tax-statement.md`
 * sets out why this ledger is not tax-grade and why a document that looks
 * authoritative is worse than none: the errors are structured and run one way,
 * upward. Nothing here may acquire a tax framing — not a heading, not a
 * filename, not a route.
 */

/**
 * What the walk did with one outflow — mirrors `DisposalOutcome` in
 * `@scani/domain`. Since SC-150 the interesting half of the question is the
 * *absence* of a realization: an outflow can pop its lots and book nothing,
 * and four different situations produce that identical arithmetic. Only one of
 * them is something a person can act on.
 */
export const DISPOSAL_OUTCOMES = [
  'realized',
  'unpriced',
  'unreviewed',
  'retained',
  'awaiting_pair',
] as const;

export const disposalOutcomeSchema = z.enum(DISPOSAL_OUTCOMES);

export type DisposalOutcomeDto = (typeof DISPOSAL_OUTCOMES)[number];

/**
 * Whose answer this row's outcome rests on (SC-324).
 *
 * `outcome` says what the walk did; this says on whose authority. They are
 * different facts and the ledger needs both, because the outcome that books
 * money — `realized` on a withdrawal — is produced by `transfer_review =
 * 'left_control'` alone, and that column carries two things at once: an answer
 * a person gave, and a value something wrote. In production on 2026-08-17, 560
 * of the 561 `left_control` rows are the second kind, and between them they
 * account for -39,349.52 USD of a -33,026.05 USD realized total. A ledger that
 * renders both as "you said this left your portfolio" is asserting a
 * provenance for a figure that does not have one.
 *
 * The review queue has drawn this distinction since SC-241
 * (`AnsweredTransferReview.answerSource`); this is the same distinction on the
 * surface that shows the money. It is deliberately the same two words plus a
 * third, rather than a nullable `AnswerSource`:
 *
 * - `user`         — `transfer_reviewed_at` is set. Provable.
 * - `unattributed` — an answer is on the row and nothing records who gave it.
 *   Claims only the contrapositive; see `ANSWER_SOURCES` for why `import` and
 *   `machine` were rejected.
 * - `none`         — no answer is involved at all. A sale or swap the importer
 *   recorded, or an outflow still waiting in the queue. `outcome` separates
 *   those two.
 *
 * Non-nullable on purpose. A nullable field is the exact shape catalogued in
 * `docs/technical/2026-08-15_absence-and-refusal.md`, and instance 13 of that
 * document is provenance computed correctly and then dropped before the wire —
 * which is what this field exists to stop happening a second time.
 */
export const DISPOSAL_ANSWER_SOURCES = [...ANSWER_SOURCES, 'none'] as const;

export const disposalAnswerSourceSchema = z.enum(DISPOSAL_ANSWER_SOURCES);

export type DisposalAnswerSourceDto = (typeof DISPOSAL_ANSWER_SOURCES)[number];

/**
 * Which of the two price routes valued a row (SC-397) — mirrors
 * `ValuationBasis` in `@scani/domain`.
 *
 * `execution_rate` is the rate the trade executed at, recorded by the importer
 * and denominated in the counter asset; `held_token` is the token in hand at
 * spot on the day. The distinction only becomes interesting on a swap, where
 * the second is a fallback rather than the primary route — and it is a
 * fallback that had to be built, because refusing it is what made an
 * unpriceable counter asset book 0.00.
 */
export const VALUATION_BASES = ['execution_rate', 'held_token'] as const;

export const valuationBasisSchema = z.enum(VALUATION_BASES);

export type ValuationBasisDto = (typeof VALUATION_BASES)[number];

/**
 * One outflow matched against one acquisition lot.
 *
 * Money is a Decimal string, never a float — a row exists to be checked
 * against the figure above it, and a display that rounds differently from the
 * arithmetic is the reason to distrust both.
 */
export const disposalLotMatchSchema = z.object({
  transactionId: z.string(),
  holdingId: z.string(),
  tokenId: z.string(),
  /** Raw: `sell` | `swap_out` | `withdraw` | `transfer_out`. Read with
   *  `outcome` — whether a withdrawal was a disposal is a question the user
   *  answered, not something the kind alone says. */
  kind: z.string(),
  disposedAt: z.string(),
  /** Null on the portion of an outflow no acquisition lot covered. */
  acquiredAt: z.string().nullable(),
  quantity: z.string(),
  /** Null when nothing was valued — either no price route resolved, or this
   *  outcome never asked for one. `outcome` tells which. */
  proceeds: z.string().nullable(),
  costBasis: z.string(),
  /** Null wherever nothing was realized. The non-null gains sum to the
   *  realized figure the rest of the app shows, exactly. */
  gain: z.string().nullable(),
  holdingDays: z.number().nullable(),
  /**
   * Which share of its outflow this row belongs to (SC-181).
   *
   * One outflow can be answered as several things at once — 3,500 moved to an
   * untracked account and 500 genuinely left — and the two halves have
   * different outcomes, different proceeds and different gains. Grouping the
   * ledger by `transactionId` alone would fold them into one row whose single
   * `outcome` is true of neither half, which is a ledger that has stopped
   * explaining. `transactionId + portionIndex` is the event a reader
   * recognises; `portionCount` is what lets the row say it is a part.
   *
   * `0` / `1` on every unsplit row, which is almost all of them.
   */
  portionIndex: z.number().int().nonnegative(),
  portionCount: z.number().int().positive(),
  /** `known` | `partial` | `unknown` — see `CostBasisQuality` (SC-149). A
   *  gain derived from a knowingly-truncated history has to say so here, or
   *  the explanation misleads more confidently than the bare number did. */
  basisQuality: z.enum(['known', 'partial', 'unknown']),
  outcome: disposalOutcomeSchema,
  /** Which price answered for `proceeds` (SC-397) — mirrors `ValuationBasis`
   *  in `@scani/domain`. Null when nothing did.
   *
   *  `held_token` on a swap is the row worth reading. A swap is valued from
   *  its execution rate, which is denominated in the asset that came back;
   *  when that asset has no price on the day the leg is valued from the token
   *  that left instead. Until SC-397 it was valued at nothing at all, and a
   *  disposal booked at 0.00 is indistinguishable on screen from one that
   *  genuinely earned nothing. The two routes disagree by up to 2.44% on the
   *  legs where both resolve, which is small and is not zero — so the ledger
   *  says which one it used rather than trading a silent zero for a silent
   *  estimate. */
  valuationBasis: valuationBasisSchema.nullable(),
  /** `user` | `unattributed` | `none` — see `DISPOSAL_ANSWER_SOURCES`. Read it
   *  with `outcome`: together they say what happened and on whose authority. */
  answerSource: disposalAnswerSourceSchema,
});

export type DisposalLotMatchDto = z.infer<typeof disposalLotMatchSchema>;

export const realizedLedgerSchema = z.object({
  holdingId: z.string(),
  baseCurrencyId: z.string().nullable(),
  rows: z.array(disposalLotMatchSchema),
  /** The sum of every non-null `gain`, as a Decimal string. It is the same
   *  number the holding's realized PnL carries, and it is returned rather
   *  than left to the client to add up so the two can never drift apart in a
   *  rounding rule. */
  realizedTotal: z.string(),
});

export type RealizedLedger = z.infer<typeof realizedLedgerSchema>;
