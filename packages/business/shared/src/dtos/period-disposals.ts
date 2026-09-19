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
 * **The contract under SC-90's tax-year statement** (mgrin re-scoped it on
 * 2026-09-11). The window is still two instants: `taxYearDisposalsSchema` below
 * adds the year, its start and the zone the instants were read in, so nothing
 * here guesses a jurisdiction. `docs/technical/2026-08-14_why-no-tax-statement.md`
 * records the eleven ways the ledger underneath falls short of tax-grade; the
 * counts below are how a statement discloses them, and it must.
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

/**
 * Where a tax year starts (SC-90). `jan-1` is the calendar year, `apr-1` NZ,
 * HK, JP and IN, `apr-6` the UK, `jul-1` AU. There is no default: the
 * cost-basis method is not the jurisdiction, so the caller always names it.
 */
export const TAX_YEAR_STARTS = ['jan-1', 'apr-1', 'apr-6', 'jul-1'] as const;
export const taxYearStartSchema = z.enum(TAX_YEAR_STARTS);
export type TaxYearStart = z.infer<typeof taxYearStartSchema>;

/**
 * One receipt of investment income (SC-90). `value` is base currency at
 * receipt, valued the way cost basis values the lot the same receipt opens; null
 * when no price route resolved, and counted in `unvalued` rather than zeroed.
 */
export const incomeRowSchema = z.object({
  transactionId: z.string(),
  holdingId: z.string(),
  tokenId: z.string(),
  kind: z.enum(['interest', 'reward', 'airdrop']),
  receivedAt: z.string(),
  quantity: z.string(),
  value: z.string().nullable(),
  stale: z.boolean(),
});

/**
 * Income over the tax year (mgrin, 2026-09-11): interest and rewards are
 * totalled; airdrops are listed and have NO total. `totals` is strict, so a
 * server that ever sent an airdrop total would fail its own contract rather
 * than hand a client a figure the statement must not assert.
 */
export const taxYearIncomeSchema = z.object({
  rows: z.array(incomeRowSchema),
  totals: z.object({ interest: z.string(), reward: z.string() }).strict(),
  unvalued: z.object({
    interest: z.number().int().nonnegative(),
    reward: z.number().int().nonnegative(),
    airdrop: z.number().int().nonnegative(),
  }),
});

export type TaxYearIncome = z.infer<typeof taxYearIncomeSchema>;

/**
 * One tax year's disposals: the window above, derived from a year number and
 * its start, with the zone its boundaries were read in. `timeZoneSource` says
 * whether that zone is the user's own or the UTC fallback used when none is
 * stored, so a boundary a day off is visible as such rather than silent.
 */
export const taxYearDisposalsSchema = periodDisposalsSchema.extend({
  /**
   * ISO instant the figures were computed. A closed year is re-walked on every
   * read, so a statement is stamped with this beside its method; two
   * statements that differ can then be told apart (Operator ruling, bus #12532).
   */
  generatedAt: z.string(),
  taxYear: z.object({
    year: z.number().int(),
    yearStart: taxYearStartSchema,
    timeZone: z.string(),
    timeZoneSource: z.enum(['user', 'utc-fallback']),
  }),
  income: taxYearIncomeSchema,
});

export type TaxYearDisposals = z.infer<typeof taxYearDisposalsSchema>;

/**
 * The words on a tax-year PDF, supplied by the client in the reader's language.
 * Words only: every figure on the document is computed by the server from the
 * ledger, so a client cannot print a number the ledger did not produce.
 */
export const taxYearPdfLabelsSchema = z.object({
  subject: z.string().min(1),
  headers: z.object({
    date: z.string(),
    asset: z.string(),
    quantity: z.string(),
    acquired: z.string(),
    amount: z.string(),
    costBasis: z.string(),
    gain: z.string(),
    daysHeld: z.string(),
  }),
  groups: z.object({
    disposals: z.string(),
    interest: z.string(),
    rewards: z.string(),
    airdrops: z.string(),
  }),
  /** Labels for the block above the table. Its label column truncates past about 18 characters. */
  details: z.object({
    year: z.string(),
    method: z.string(),
    timeZone: z.string(),
    gainTotal: z.string(),
    interestTotal: z.string(),
    rewardTotal: z.string(),
    airdropNote: z.string(),
    caveat: z.string(),
    /** Rows whose cost basis is partial or unknown (short or stale history). */
    basisIncomplete: z.string(),
    /** Outflows still waiting on the owner's answer or on a transfer pair. */
    awaitingReview: z.string(),
    /** Income receipts no price route could value. */
    unvaluedIncome: z.string(),
  }),
  /** Each cost-basis method in words, so the statement never prints a code. */
  methods: z.object({ fifo: z.string().min(1), uk_section_104: z.string().min(1) }),
  /** Each tax-year start in words. */
  yearStarts: z.object({
    'jan-1': z.string().min(1),
    'apr-1': z.string().min(1),
    'apr-6': z.string().min(1),
    'jul-1': z.string().min(1),
  }),
  /** What the airdrops line says instead of a total. */
  airdropNote: z.string().min(1),
  /** The v1 caveat (Operator ruling, bus #12532). Required: a statement without it is not issued. */
  caveat: z.string().min(1),
});

export type TaxYearPdfLabels = z.infer<typeof taxYearPdfLabelsSchema>;
