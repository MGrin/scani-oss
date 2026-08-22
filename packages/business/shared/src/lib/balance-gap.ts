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
 * Measured on production 2026-08-22: `Edge Capital` USD, `IBKR Portfolio`'s
 * USD cash, `Monzo Savings` GBP and all four `Tinkoff` RUB holdings carry
 * **zero transactions of any kind**. `Revolut Savings` and `Wise Savings`
 * carry 70 rows each and every one is an `apy-payout` accrual. No transaction
 * adapter exists for any of these institutions, so no import will ever
 * explain a deposit into them. Somebody saying so is the only way a flow can
 * reach the ledger.
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
 * Measured on production 2026-08-22, three rows from the same population:
 *
 * | holding | drift (quantity) | in USD |
 * |---|---|---|
 * | Tinkoff RUB | 3,684.00 | ~40 |
 * | Revolut Savings USD | 1,000.00 | 1,000 |
 * | IBKR FXI | 172.85 (shares) | 6,236 |
 *
 * A quantity threshold is wrong in both directions at once: it ranks 40 USD
 * of roubles above a real 1,000 USD transfer, and it hides a 6,236 USD share
 * movement behind a quantity of 172.85. The total that has been quoted for
 * this population — 124,151.09 — is `SUM(ABS(drift))` with nothing converted,
 * so it adds roubles to dollars to share counts and is not money in any
 * currency. Priced, the same population is 128,227.18 USD.
 *
 * ## Why 250
 *
 * Measured on production 2026-08-22 across every user, priced:
 *
 * | floor | gaps | share of the money |
 * |---|---|---|
 * | ≥ 1000 | 25 | 82.9% |
 * | **≥ 250** | **62** | **97.2%** |
 * | ≥ 50 | 89 | 99.4% |
 * | any | 379 | 100% |
 *
 * 250 is where the queue is still a queue — 62 items across the whole product,
 * 37 of them the heaviest owner's, arriving at roughly 12 a month — while
 * leaving 2.8% of the money unasked about. The 290 gaps below 50 carry 807.44
 * USD between them; asking about those is what turns a queue into a wall, and
 * a wall is abandoned, which surfaces none of the 97.2%.
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
 * asked for. Above it — the seventy-one-day Edge Capital gap, the forty-day
 * IBKR one — only the owner knows, so the question is worth asking, and the
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
 * Measured on production 2026-08-22: 1,000 USDC left an Ethereum wallet at
 * 06:01:26, with the matching gas fee on the same wallet in the same second.
 * The wallet's transactions come from Etherscan. At 06:48 — forty-seven
 * minutes later — there were still ZERO transaction rows for that leg, and
 * the most recent Etherscan-sourced rows in the database had been created at
 * 01:00:14 for a different wallet on a different chain. The owner confirms it
 * was a real transfer: he sent the USDC and received roughly 82,000 RUB for
 * it, and he had already booked the RUB half by hand.
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
 * attributable: "62 of 379, and here is where the other 317 went" is a
 * different claim from "62". A suppression that cannot be counted is
 * indistinguishable from a query that missed rows.
 */
export const BALANCE_GAP_SUPPRESSIONS = [
  /** Below `BALANCE_GAP_MIN_BASE_VALUE` once priced. */
  'below-threshold',
  /**
   * Closing observation is not a `sync-capture` — the owner wrote it. A
   * manual balance edit is already an answer, and SC-510 asked its own
   * question at the moment it was made.
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
 * Measured on production 2026-08-22. `IBKR Portfolio`'s FXI position was
 * observed at 47.85 → 54.13 → **234.13** → **234.13** → 65.45 → 65.45 → 67.58
 * shares, every row a `sync-capture`, with no transaction anywhere near it.
 * The position was 234.13 shares for a single day and 65.45 either side. That
 * produces a drift of +172.85 followed by −172.85 on the next interval.
 *
 * Priced at ~36 USD a share those two are **6,236 and 5,986 USD** — the second
 * and third largest prompts in the entire product, for a position that never
 * changed. The first thing the owner would have been asked about is a
 * brokerage feed glitch, twice.
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
