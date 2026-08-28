import { z } from 'zod';
import { costBasisMethodSchema } from './cost-basis';
import { disposalLotMatchSchema } from './realized-ledger';

/**
 * Every disposal in a portfolio over a window of time (SC-90).
 *
 * `realizedLedger` answers "why did my realized gain on THIS HOLDING change?".
 * This answers the same question one axis wider — across every holding, over a
 * chosen window — which is what a person asks when they want to know what
 * their year did rather than what one position did.
 *
 * **Explicitly not tax output, on the same terms as the ledger it is built
 * from.** `docs/technical/2026-08-14_why-no-tax-statement.md` sets out eleven
 * reasons the ledger underneath is not tax-grade, and the errors it documents
 * are structured and run one way, upward. Nothing here may acquire a tax
 * framing — not a heading, not a filename, not a route. A window happening to
 * be a calendar year does not make it a tax year, and the shape deliberately
 * takes two instants rather than a year number so that nothing in the contract
 * implies a jurisdiction's idea of where a year starts.
 *
 * ## The window is half-open, `[periodStart, periodEnd)`
 *
 * So two adjacent windows partition disposals exactly: a disposal at the
 * instant of a boundary belongs to the later window and to one window only. An
 * inclusive upper bound would put a midnight disposal in both, which is the
 * one arithmetic error a reader adding two periods together cannot see.
 *
 * ## The window bounds what is REPORTED, never what is WALKED
 *
 * A lot bought years before `periodStart` is what supplies the cost basis of a
 * sale inside the window, so the walk always runs from the beginning of the
 * holding's history. Truncating the walk to the window instead would report a
 * zero basis and the entire proceeds as gain — a confident, plausible,
 * uniformly overstated number. `PeriodDisposalsService` documents the upper
 * bound's separate reason.
 */

/** Money over the window, summed by the server so a client cannot round it
 *  into a different figure from the rows it sits above. Decimal strings. */
export const periodDisposalTotalsSchema = z.object({
  /** Sum of every non-null `proceeds`. Rows with a null proceeds contribute
   *  nothing and are counted in `byOutcome`, which is where a reader sees how
   *  many there were. */
  proceeds: z.string(),
  /** Sum of every `costBasis`, including the zeroes on rows that matched no
   *  acquisition lot. Read it beside `byBasisQuality`. */
  costBasis: z.string(),
  /** Sum of every non-null `gain`. This is NOT `proceeds - costBasis`: a row
   *  can carry a cost basis and a null gain (an outflow that popped its lots
   *  and booked nothing), so the two are computed over different subsets and
   *  publishing only the subtraction would state a figure nothing measured. */
  gain: z.string(),
});

export type PeriodDisposalTotals = z.infer<typeof periodDisposalTotalsSchema>;

/**
 * How many rows fell into each outcome — every bucket present, always.
 *
 * Written out rather than derived from `DISPOSAL_OUTCOMES` so the wire type is
 * total rather than partial: an absent key and a zero are different readings,
 * and a client doing `counts[outcome] ?? 0` cannot tell "none of these" from
 * "this server does not know about that outcome". A test pins these keys
 * against `DISPOSAL_OUTCOMES`, so adding an outcome without adding a bucket
 * fails rather than silently dropping rows out of the census.
 */
export const disposalOutcomeCountsSchema = z.object({
  realized: z.number().int().nonnegative(),
  unpriced: z.number().int().nonnegative(),
  unreviewed: z.number().int().nonnegative(),
  retained: z.number().int().nonnegative(),
  awaiting_pair: z.number().int().nonnegative(),
});

export type DisposalOutcomeCounts = z.infer<typeof disposalOutcomeCountsSchema>;

/**
 * How many rows rest on how much (SC-149), same three grades the ledger uses.
 *
 * This is the qualification that stops `totals.gain` reading as a settled
 * figure. `unknown` means there was no acquisition to match at all, so the
 * whole of that row's proceeds became gain; `partial` means the holding's
 * history is knowingly truncated or a leg was priced beyond the freshness
 * window. Both produce a number that looks exactly like a known one.
 */
export const disposalBasisQualityCountsSchema = z.object({
  known: z.number().int().nonnegative(),
  partial: z.number().int().nonnegative(),
  unknown: z.number().int().nonnegative(),
});

export type DisposalBasisQualityCounts = z.infer<typeof disposalBasisQualityCountsSchema>;

export const periodDisposalsSchema = z.object({
  /** ISO instant, INCLUSIVE. */
  periodStart: z.string(),
  /** ISO instant, EXCLUSIVE — see the half-open note above. */
  periodEnd: z.string(),
  /** Null only when the user has no base currency, in which case there is no
   *  ledger to report rather than an empty one — every figure here is
   *  denominated in it. */
  baseCurrencyId: z.string().nullable(),
  /**
   * The identification rule the walk ran under (SC-462), echoed back because
   * it CHANGES THE NUMBERS. `fifo` and `uk_section_104` match different
   * acquisitions to the same disposal, so a figure quoted without its method
   * is a figure a reader cannot reproduce.
   */
  costBasisMethod: costBasisMethodSchema,
  /** Newest disposal first, one row per (outflow, acquisition lot) pair. */
  rows: z.array(disposalLotMatchSchema),
  /**
   * `rows.length`, returned rather than left to be counted, so every total
   * above arrives with the size of the set it was taken over. A sum with no
   * denominator is a claim about an unnamed population.
   */
  rowCount: z.number().int().nonnegative(),
  /** Sums to `rowCount`. */
  byOutcome: disposalOutcomeCountsSchema,
  /** Sums to `rowCount`. */
  byBasisQuality: disposalBasisQualityCountsSchema,
  totals: periodDisposalTotalsSchema,
});

export type PeriodDisposals = z.infer<typeof periodDisposalsSchema>;
