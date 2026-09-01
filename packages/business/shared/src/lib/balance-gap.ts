/**
 * "We think money moved here — tell us" (SC-501).
 *
 * ## What a balance gap is
 *
 * One pair of consecutive balance observations on a holding, where
 *
 * ```
 * after.balance − before.balance − Σ transactions in (before, after]
 * ```
 *
 * is not zero. Something changed the balance and the ledger holds no reason
 * for it. `unexplainedDrift` in `@scani/domain` is the one implementation of
 * that arithmetic and `BalanceAtTimeService.driftAhead` — which spreads the
 * same quantity across the gap to keep a value series from stepping — calls
 * it, so the queue and the interpolation cannot disagree about what is
 * unexplained.
 *
 * ## Why it is a question and not a classification
 *
 * The drift is observable; what it MEANT is not. Booking it as an external
 * flow would cancel a departure against an arrival and take the headline
 * close to what net worth says — and it would do that by declaring an
 * undated, unexplained balance change to be a contribution or a withdrawal,
 * on evidence that is only *the balance changed and we hold no reason*. That
 * claim has never been made in this codebase.
 *
 * Leaving it as performance is the status quo: flattering on inflows,
 * punishing on outflows. Measured on production 2026-08-22, it is the largest
 * remaining error in one owner's time-weighted return.
 *
 * So neither. The owner is asked, the answer is theirs, it carries a real
 * date and a real amount, and the return corrects itself through the ordinary
 * transaction path. **Nothing here infers a flow.**
 *
 * ## Why a human is not the preferred channel but the only one
 *
 * Measured against a real dataset: every cash and savings holding at an
 * institution we have no transaction adapter for carries **zero transactions
 * of any kind**, and the few that carry any at all carry nothing but
 * `apy-payout` accruals. With no adapter, no import will ever explain a
 * deposit into them. Somebody saying so is the only way a flow can reach the
 * ledger.
 */

import { MANUAL_EDIT_CAUSES, type ManualEditCause } from './manual-balance-edit';

/**
 * What the owner can say a gap was.
 *
 * The first three are `MANUAL_EDIT_CAUSES` **verbatim**, not a parallel
 * vocabulary that happens to have the same members today. SC-510 already asks
 * exactly this question about a balance change the owner typed, and
 * `ManualBalanceEditService` already writes the right row for each answer:
 * `flow` a `deposit`/`withdraw` at a date they give, `correction` a
 * backdated restatement, `growth` deliberately nothing. This asks the same
 * question about a change a *sync* observed, so a second vocabulary could
 * only ever drift from the first.
 *
 * `unknown` is the fourth and it exists only here. See below.
 */
export const BALANCE_GAP_ANSWERS = [...MANUAL_EDIT_CAUSES, 'unknown'] as const;

export type BalanceGapAnswer = (typeof BALANCE_GAP_ANSWERS)[number];

/**
 * "I don't know" — a supported answer, not a dead end.
 *
 * A queue whose only exits are three confident answers is a queue people
 * abandon at the first row they cannot place, and the rows nobody can place
 * are exactly the old ones this feature exists for. So it is answerable, it
 * writes **no ledger row** — the drift stays interpolated and stays
 * attributed to performance, which is the honest treatment of a change nobody
 * can explain — and it stamps the review so the same gap is not asked about
 * again.
 *
 * It is deliberately NOT a member of `MANUAL_EDIT_CAUSES`. That type is the
 * input to `ManualBalanceEditService.record`, which must keep exhausting its
 * three branches; adding a fourth there would put a value into a writer whose
 * whole job is to write something.
 */
export const BALANCE_GAP_UNKNOWN: BalanceGapAnswer = 'unknown';

export function isBalanceGapAnswer(value: unknown): value is BalanceGapAnswer {
  return typeof value === 'string' && (BALANCE_GAP_ANSWERS as readonly string[]).includes(value);
}

/** The three answers that reach `ManualBalanceEditService`. */
export function isLedgerWritingAnswer(answer: BalanceGapAnswer): answer is ManualEditCause {
  return answer !== BALANCE_GAP_UNKNOWN;
}

/**
 * The floor, in the owner's base currency, below which a gap is not worth
 * asking about.
 *
 * ## Base currency, and why the obvious unit is wrong
 *
 * The threshold is applied to `|drift| × price at the interval's end`,
 * converted to the owner's base currency — never to the raw quantity.
 *
 * Measured on production 2026-08-22, three rows from the same population sit
 * in three different units: a rouble cash drift with a large quantity and a
 * negligible value, a dollar cash drift where quantity and value coincide, and
 * a small share count worth several thousand dollars.
 *
 * A quantity threshold is wrong in both directions at once: it ranks the
 * near-worthless rouble drift above a real dollar transfer, and it hides a
 * several-thousand-dollar share movement behind a two-figure quantity. Any
 * total quoted for this population as `SUM(ABS(drift))` with nothing converted
 * adds roubles to dollars to share counts and is not money in any currency.
 *
 * ## Why 250
 *
 * Measured on production 2026-08-22 **across every user**, priced. That is
 * the whole product and not one queue: `BalanceGapService.listPending` is
 * scoped to a `userId`, so no reader will ever see these totals on a page.
 * Re-measured 2026-08-22 for SC-576, the population is concentrated in one
 * account with the rest spread thinly — which is why a per-account page was
 * mistaken for the threshold having stopped working.
 *
 * The share of the money captured rises steeply to a floor of 250 and then
 * flattens: raising it to 1000 drops a material slice of the value, while
 * lowering it to 50 buys a fraction of a percent more and roughly half again
 * as many questions.
 *
 * 250 is where the queue is still a queue — a manageable number of items across
 * the whole product, arriving at a rate an owner can keep up with — while
 * leaving only a sliver of the money unasked about. The long tail of gaps below
 * 50 carries very little between them; asking about those is what turns a queue
 * into a wall, and a wall is abandoned, which surfaces none of the value the
 * threshold exists to reach.
 */
export const BALANCE_GAP_MIN_BASE_VALUE = 250;

/**
 * How wide an interval has to be before the owner is asked WHEN, rather than
 * just what.
 *
 * ## The failure this exists to avoid, measured
 *
 * A date field collects a DAY. A day becomes an instant at local midnight, and
 * the interval it is meant to explain is an instant range. On production
 * 2026-08-22 the owner — in UTC+8 — answered a balance change by writing a
 * date-only entry; it was stamped `2026-08-21 16:00:00Z`, which is exactly
 * `2026-08-22 00:00` in his zone. The balance change it described happened
 * between 05:01 and 06:01 UTC, i.e. 13:01–14:01 local.
 *
 * So a date-only answer lands **fourteen hours before** the hour it explains,
 * systematically, for every user in every zone. On a one-hour interval a
 * date-only answer can essentially never fall inside it. Any design that
 * requires the answer's timestamp to land in the interval therefore refuses
 * almost every honest answer — which is why this queue clamps instead of
 * refusing, and why it does not ask at all when asking cannot help.
 *
 * ## The rule
 *
 * Below this span, the two observations already date the movement more
 * precisely than the owner can: an hour of wall clock beats a recollection of
 * which day it was. The answer is stamped inside the interval and no date is
 * asked for. Above it — the months-long gaps a sparsely-observed cash
 * holding accumulates — only the owner knows, so the question is worth
 * asking, and the
 * answer is clamped into the interval because that is where the evidence says
 * the money moved.
 */
export const BALANCE_GAP_DATE_PROMPT_MIN_SPAN_MS = 24 * 60 * 60 * 1000;

/**
 * There is no settling window, and the absence is deliberate (SC-501).
 *
 * A drift CAN be explained by a transaction that has not been imported yet,
 * and the obvious response is to wait — hold a gap back until the feeds that
 * cover its holding have had a chance to deliver. That was the first design
 * and it was wrong, in a way worth recording so it is not re-added.
 *
 * **"The feed will handle it" is a prediction, and it was tested and failed.**
 * Measured against a real dataset: a stablecoin outflow left an Ethereum
 * wallet, with the matching gas fee on the same wallet in the same second.
 * That wallet's transactions come from Etherscan. Three quarters of an hour
 * later there were still ZERO transaction rows for that leg, and the most
 * recent Etherscan-sourced rows in the database were hours old and belonged
 * to a different wallet on a different chain. The owner confirmed it was a
 * real transfer, sold for fiat, and had already booked the fiat half by
 * hand.
 *
 * An age window would have hidden a genuine, large, half-answered transfer
 * for two days on the theory that something else was about to explain it.
 *
 * **So the rule is the checkable one instead: a gap is suppressed when a
 * transaction explains the interval — which is not a rule at all, because a
 * transaction that explains the interval makes the drift zero and there is no
 * gap.** That is the whole point. The queue is computed on read, so if the
 * feed lands the transfer later the item leaves by itself, with no window to
 * tune and nothing to expire.
 *
 * What this does NOT solve, stated rather than papered over: if the owner
 * answers a gap and the feed then imports the same movement, the ledger holds
 * both. `answer` re-derives the gap and refuses when the drift has already
 * gone, which closes the race up to the moment of answering and not after it.
 * That exposure is the same one SC-510's manual balance edit already carries.
 */

/**
 * Why a gap was not asked about.
 *
 * Counted and reported rather than silently dropped, so the queue's size is
 * attributable: "N of M, and here is where the rest went" is a different claim
 * from "N". A suppression that cannot be counted is indistinguishable from a
 * query that missed rows.
 */
export const BALANCE_GAP_SUPPRESSIONS = [
  /** Below `BALANCE_GAP_MIN_BASE_VALUE` once priced. */
  'below-threshold',
  /**
   * Closing observation is not a `sync-capture` — the owner wrote it, through
   * a statement close or SC-510's historical backfill.
   *
   * **A live manual balance edit is NOT in this set** and never has been:
   * `HoldingService.recordBalanceObservation` stamps `sync-capture` whatever
   * the caller. An edit made in the app is answered instead, by the
   * `gap_review` its own insert carries (SC-606) — a different mechanism, and
   * the wording here claiming otherwise is what made SC-606's third prompt
   * look impossible.
   */
  'owner-stated',
  /**
   * The next interval on the same holding carries the exact opposite drift
   * and no transaction explains either. See `BALANCE_GAP_REVERSAL_*` below.
   */
  'reversed',
  /** Could not be priced into the owner's base currency at all. */
  'unpriceable',
] as const;

export type BalanceGapSuppression = (typeof BALANCE_GAP_SUPPRESSIONS)[number];

export type BalanceGapSuppressionCounts = Record<BalanceGapSuppression, number>;

/**
 * A drift the next interval takes straight back is a feed artefact, not money.
 *
 * Measured on production 2026-08-22. A brokerage equity position was observed
 * jumping to several times its share count for a single day and back again,
 * every row a `sync-capture`, with no transaction anywhere near it. That
 * produces a drift of +N followed by −N on the next interval.
 *
 * Priced, those two were among the largest prompts in the entire product, for
 * a position that never changed. The first thing the owner would have been
 * asked about is a brokerage feed glitch, twice.
 *
 * So it is a rule, not a special case: a drift whose immediate successor on
 * the same holding is its exact negation, with no transaction in either
 * interval, is suppressed on both sides. Requiring the *exact* negation is
 * what keeps it from eating real money — two genuine movements that happen to
 * be close in size are not equal to the last decimal place, and a real
 * deposit followed by a real withdrawal of precisely the same amount, with no
 * transaction recorded for either, is a shape worth losing to keep this rule
 * simple enough to reason about.
 */
export const BALANCE_GAP_REVERSAL_REQUIRES_EXACT_NEGATION = true;

/** `ReviewItem.kind` for the balance-gap queue. */
export const BALANCE_GAP_REVIEW_KIND = 'balance-gap';
