import { z } from 'zod';

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
