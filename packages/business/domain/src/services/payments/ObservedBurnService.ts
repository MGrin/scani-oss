import { ANSWERABLE_OUTFLOW_KINDS, answerSourceOf } from '@scani/shared';
import Decimal from 'decimal.js';
import { Container, Service } from 'typedi';
import { valueTransactionInBase } from '../../lib/tx-valuation';
import { HoldingRepository } from '../../repositories/HoldingRepository';
import { HoldingTransactionRepository } from '../../repositories/HoldingTransactionRepository';
import { BaseService } from '../BaseService';
import { PriceGraphService } from '../pricing/PriceGraphService';
import { monthKey } from './forecast';

/**
 * How fast money actually leaves the tracked perimeter (SC-657).
 *
 * ## Why the recurring book cannot answer this
 *
 * Runway was `liquid ÷ burn` with burn read from the book of recurring
 * payments. Reported by mgrin from production use: that book does not
 * describe how he spends money. Income arrives, some goes to tracked wealth
 * accounts, the rest goes to current accounts Scani deliberately does not
 * track, and is spent from there. For something expensive he moves money OUT
 * of a tracked account into an untracked one.
 *
 * So from Scani's side his burn is not a schedule. It is **the rate at which
 * money leaves the tracked perimeter**, and that signal already exists: 303
 * reviewed outflows over five years, running $4k–$43k a month and nothing
 * like a recurrence.
 *
 * ## `left_control` only, and `untracked` deliberately NOT
 *
 * The two look interchangeable and are not. `transfer-review.ts` defines them:
 * `left_control` is "it really did leave the portfolio: sold off-platform,
 * gifted, spent"; `untracked` is "still the user's money, in an account Scani
 * cannot see (a cold wallet, an exchange we have no key for)". Moving coin to
 * a cold wallet is wealth changing address, not money spent, and counting it
 * would report a burn nobody incurred.
 *
 * `paired` and `internal` are excluded for the same reason more obviously:
 * both name a destination INSIDE the perimeter.
 *
 * That choice is a judgement about two English sentences, so it is stated
 * here, counted in `excluded`, and shown on the surface rather than left for
 * a reader to infer from a number.
 *
 * ### It is a VOCABULARY ASSUMPTION, and it can go wrong silently
 *
 * Note the tension with the paragraph above: mgrin describes his spending
 * destination as "current accounts, **not tracked by scani**". By the
 * vocabulary's own definition that is an untracked account — so the same
 * real-world move could reasonably be answered either way, and which one he
 * clicks may be habit rather than semantics.
 *
 * Today the assumption holds empirically: 303 `left_control` rows against 5
 * `untracked`, and the `left_control` months match the magnitudes he
 * described. So this is not currently costing anything.
 *
 * **The hazard is that the failure has no signal.** If answers start landing
 * on `untracked`, burn falls, the runway lengthens, and nothing goes red —
 * the number does not become wrong loudly, it quietly stops counting a
 * category. `excluded.untracked` rising while `total` falls is the only place
 * it is visible, which is the reason that count is returned rather than
 * dropped.
 *
 * ## Complete calendar months only
 *
 * The current month is excluded because it is partial. Averaging a month that
 * is three days old drags the mean down and makes the runway LONGER — wrong
 * in the flattering direction, which is the one direction this codebase
 * refuses to be wrong in (`RunwayLine.tsx`: "a line that is wrong in the
 * flattering direction is worse than no line").
 *
 * ## The mean, not the median, and why it is on the surface
 *
 * Six of his months span $4k–$43k, so the two differ materially and the
 ***REMOVED***
 ***REMOVED***
 * balance actually drained at, and a $43k month is real money that really
 ***REMOVED***
 * like — and a runway built on it survives on paper past the point the
 * account is empty.
 *
 * `min`, `max` and `median` travel with the mean so the spread the mean hides
 * is available to say out loud. A single number over that range, presented
 * alone, is more confident than the data.
 */

/** Complete calendar months averaged. Matches the forecast's 6-month default. */
export const OBSERVED_BURN_WINDOW_MONTHS = 6;

export interface ObservedBurnMonth {
  /** `YYYY-MM`. */
  month: string;
  /** Base currency, `"0"` for a month with no perimeter exits. */
  amount: string;
}

/**
 * Outflows the window contained that this figure does NOT include.
 *
 * Present so the surface can say so. A burn that silently drops the rows it
 * could not classify reports a confident zero for them, which is
 * indistinguishable from having looked and found nothing.
 */
export interface ObservedBurnExcluded {
  /** `transfer_review IS NULL` — nobody has answered yet. */
  unclassified: number;
  /** Answered `untracked`: still the user's money, somewhere Scani cannot see. */
  untracked: number;
  /** Answered `paired` or `internal`: the destination is inside the perimeter. */
  internal: number;
  /** `left_control`, but no price could value it. Counted, never treated as 0. */
  unvalued: number;
}

/**
 * WHO ANSWERED THE ROWS THIS FIGURE IS MADE OF, by VALUE (SC-661/SC-673).
 *
 * ## Why value and never count
 *
 * The figure this qualifies is a value — base-currency money, and months
 * derived from money — so a count-weighted share describes a different
 * quantity than the number it sits under. Measured on the production book,
 ***REMOVED***
 ***REMOVED***
 ***REMOVED***
 ***REMOVED***
 *
 * The count is the flattering one, so it is not returned at all rather than
 * returned with a comment asking nobody to use it. This feature has erred
 * flattering at every layer examined — the committed book, the decoder, and a
 * declared estimate would have too. The caption that exists to stop that must
 * not do it as well.
 *
 * ## Three classes, and the middle one is not decoration
 *
 * `rule` and `repair` are collapsed into `automated` because they are the same
 * claim to a reader: a named mechanism decided this, and you can go and read
 * it. `unattributed` is a different claim — a decision with no author at all.
 * Collapsing those two would be the same error as collapsing `internal` into
 * `untracked` on the excluded side: one is a fact, the other is the absence of
 * one.
 *
 * The distinction is load-bearing because of an ASYMMETRY on the production
 * book: the transfer-linking repair job DOES stamp itself — all 5
 * internal/paired rows carry `repair` — so whatever answered the unstamped
 * rows was not that job. The benign reading, that a known job did it and
 * forgot to stamp, is ruled out by the known job stamping.
 *
 * ## The value is the same proxy the burn itself uses
 *
 * Accumulated from the same `valueTransactionInBase` result the month buckets
 * are built from, so the three parts sum to `total` exactly and cannot drift
 * from the figure they describe.
 */
interface ObservedBurnProvenance {
  /** Base currency. The user answered these. */
  user: string;
  /** A named mechanism answered — `rule` or `repair`. Inspectable, arguable. */
  automated: string;
  /** Nobody recorded who or what decided. */
  unattributed: string;
}

export interface ObservedBurn {
  windowMonths: number;
  /** `YYYY-MM`, first complete month in the window. */
  fromMonth: string;
  /** `YYYY-MM`, last complete month in the window. */
  toMonth: string;
  perMonth: ObservedBurnMonth[];
  total: string;
  /** `total ÷ windowMonths`. THE RUNWAY DENOMINATOR. */
  perMonthMean: string;
  /** The spread the mean hides — for the surface, not for the division. */
  perMonthMedian: string;
  perMonthMin: string;
  perMonthMax: string;
  /** Rows counted toward `total`. */
  countedTransactions: number;
  excluded: ObservedBurnExcluded;
  /** Who answered the counted rows, by value. Sums to `total`. */
  provenance: ObservedBurnProvenance;
  /** Counted, but valued from a quote old enough to say so (SC-151). */
  staleValued: number;
}

/**
 * How far the measured drain may move before a confirmation stops meaning
 * anything (SC-661).
 *
 * The drain is recomputed every time the window moves, so a confirmation kept
 * as a bare timestamp goes on reading as agreement after the figure it agreed
 * with has changed — which is why `users.observed_burn_confirmed_value` stores
 * WHAT MUST STILL MATCH rather than a souvenir of what he saw.
 *
 * Exact equality is the wrong rule and would make the feature useless: one new
 * transaction moves a six-month mean by cents, so a confirmation would expire
 * within hours of being given and the surface would spend its life asking
 * again. A band is required, and the size of it is a judgement rather than a
 * measurement — 5% of 8,100 is ±405, which moves an 8.0-month runway to 7.6.
 * That is inside the noise of a monthly figure and outside the range where
 * "you confirmed this" becomes a claim about a number he never saw.
 *
 * Named and alone on this line because it is the one value here somebody will
 * want to argue with.
 */
export const CONFIRMATION_TOLERANCE = new Decimal('0.05');

/**
 * What the user has said about the measured drain, if anything (SC-661).
 *
 * FOUR STATES AND NOT THREE. `currencyChanged` is not defensive padding: the
 * answer stores its own currency precisely so a later base-currency change
 ***REMOVED***
 * happen when that occurs. Treating it as `none` would DELETE his answer from
 * the screen with no event to notice it by; treating it as live would show a
 * figure in the wrong unit. Saying the answer no longer applies is the only
 * option that is true.
 */
export type ObservedBurnAnswer =
  | { kind: 'none' }
  | { kind: 'override'; amount: string; at: Date }
  /**
   * `matches` is the whole reason the value is stored. `false` is not an error
   * state — it is the surface's instruction to stop saying he agreed, name both
   * figures, and ask again.
   */
  | { kind: 'confirmed'; value: string; at: Date; matches: boolean }
  | { kind: 'currencyChanged'; at: Date };

/**
 * Pure on purpose: no container, no repository, no clock. The judgement it
 * makes is the one thing in this feature a reader will want to check by hand.
 */
export function observedBurnAnswerOf(
  user: {
    observedBurnOverride: string | null;
    observedBurnOverrideCurrencyId: string | null;
    observedBurnOverrideAt: Date | null;
    observedBurnConfirmedValue: string | null;
    observedBurnConfirmedCurrencyId: string | null;
    observedBurnConfirmedAt: Date | null;
  },
  baseCurrencyId: string | null,
  measuredPerMonthMean: string | null
): ObservedBurnAnswer {
  if (user.observedBurnOverride !== null && user.observedBurnOverrideAt !== null) {
    if (user.observedBurnOverrideCurrencyId !== baseCurrencyId) {
      return { kind: 'currencyChanged', at: user.observedBurnOverrideAt };
    }
    return {
      kind: 'override',
      amount: user.observedBurnOverride,
      at: user.observedBurnOverrideAt,
    };
  }

  if (user.observedBurnConfirmedValue !== null && user.observedBurnConfirmedAt !== null) {
    if (user.observedBurnConfirmedCurrencyId !== baseCurrencyId) {
      return { kind: 'currencyChanged', at: user.observedBurnConfirmedAt };
    }
    return {
      kind: 'confirmed',
      value: user.observedBurnConfirmedValue,
      at: user.observedBurnConfirmedAt,
      matches: confirmationStillHolds(user.observedBurnConfirmedValue, measuredPerMonthMean),
    };
  }

  return { kind: 'none' };
}

function confirmationStillHolds(confirmed: string, measured: string | null): boolean {
  if (measured === null) return false;
  const was = new Decimal(confirmed);
  const now = new Decimal(measured);
  // A confirmed zero has no proportion to be within. Only another zero agrees
  // with it, and dividing by it would answer the question with NaN.
  if (was.isZero()) return now.isZero();
  return now.minus(was).abs().dividedBy(was.abs()).lessThanOrEqualTo(CONFIRMATION_TOLERANCE);
}

/**
 * `forecast.ts` already owns what month a thing falls in, taking `YYYY-MM-DD`.
 * Reused rather than reimplemented for a `Date`: two month conventions in one
 * feature is how a movement lands in a bucket the other half does not have.
 */
function monthOf(date: Date): string {
  return monthKey(date.toISOString().slice(0, 10));
}

/** The `windowMonths` complete months ending with the month before `asOf`. */
export function completeMonthWindow(
  asOf: Date,
  windowMonths: number
): { from: Date; to: Date; months: string[] } {
  const firstOfThisMonth = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), 1));
  const from = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth() - windowMonths, 1));
  const months: string[] = [];
  for (let i = 0; i < windowMonths; i += 1) {
    months.push(monthOf(new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + i, 1))));
  }
  return { from, to: firstOfThisMonth, months };
}

function median(values: Decimal[]): Decimal {
  if (values.length === 0) return new Decimal(0);
  const sorted = [...values].sort((a, b) => a.comparedTo(b));
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] as Decimal;
  return (sorted[mid - 1] as Decimal).plus(sorted[mid] as Decimal).dividedBy(2);
}

@Service()
export class ObservedBurnService extends BaseService {
  private readonly txRepository = Container.get(HoldingTransactionRepository);
  private readonly holdingRepository = Container.get(HoldingRepository);
  private readonly priceGraphService = Container.get(PriceGraphService);

  constructor() {
    super('ObservedBurnService');
  }

  async observed(
    userId: string,
    baseCurrencyId: string,
    asOf: Date = new Date(),
    windowMonths: number = OBSERVED_BURN_WINDOW_MONTHS
  ): Promise<ObservedBurn> {
    const { from, to, months } = completeMonthWindow(asOf, windowMonths);
    const empty = (): ObservedBurn => ({
      windowMonths,
      fromMonth: months[0] as string,
      toMonth: months[months.length - 1] as string,
      perMonth: months.map((month) => ({ month, amount: '0' })),
      total: '0',
      perMonthMean: '0',
      perMonthMedian: '0',
      perMonthMin: '0',
      perMonthMax: '0',
      countedTransactions: 0,
      excluded: { unclassified: 0, untracked: 0, internal: 0, unvalued: 0 },
      provenance: { user: '0', automated: '0', unattributed: '0' },
      staleValued: 0,
    });

    const transactions = await this.txRepository.findByRange({
      userId,
      from,
      to,
      kinds: [...ANSWERABLE_OUTFLOW_KINDS],
    });
    if (transactions.length === 0) return empty();

    const excluded: ObservedBurnExcluded = {
      unclassified: 0,
      untracked: 0,
      internal: 0,
      unvalued: 0,
    };

    const exits = transactions.filter((tx) => {
      switch (tx.transferReview) {
        case 'left_control':
          return true;
        case 'untracked':
          excluded.untracked += 1;
          return false;
        case 'paired':
        case 'internal':
          excluded.internal += 1;
          return false;
        default:
          // NULL, and any answer a later migration adds that this service has
          // not been taught. Both are "not counted, and said out loud".
          excluded.unclassified += 1;
          return false;
      }
    });
    if (exits.length === 0) return { ...empty(), excluded };

    ***REMOVED***
    ***REMOVED***
    // (SC-471), and this service runs on the home screen.
    const holdingRows = await this.holdingRepository.findByIds([
      ...new Set(exits.map((tx) => tx.holdingId)),
    ]);
    const heldTokenByHolding = new Map(holdingRows.map((row) => [row.id, row.tokenId]));
    const tokenIds = new Set<string>(heldTokenByHolding.values());
    for (const tx of exits) {
      if (tx.tokenId) tokenIds.add(tx.tokenId);
      if (tx.priceNativeTokenId) tokenIds.add(tx.priceNativeTokenId);
    }
    const priceLookup = await this.priceGraphService.buildPriceLookup(
      tokenIds,
      baseCurrencyId,
      to,
      undefined
    );

    const byMonth = new Map<string, Decimal>(months.map((month) => [month, new Decimal(0)]));
    // Accumulated from the SAME valuation the month buckets use, so the three
    // parts sum to `total` exactly and cannot drift from the figure they
    // describe.
    const provenance = {
      user: new Decimal(0),
      automated: new Decimal(0),
      unattributed: new Decimal(0),
    };
    let counted = 0;
    let staleValued = 0;

    for (const tx of exits) {
      const quantity = new Decimal(tx.quantity);
      if (quantity.isZero()) continue;
      const heldTokenId = heldTokenByHolding.get(tx.holdingId) ?? tx.tokenId ?? null;
      const valuation = await valueTransactionInBase(
        this.priceGraphService,
        undefined,
        tx,
        quantity.abs(),
        baseCurrencyId,
        heldTokenId,
        priceLookup
      );
      if (!valuation) {
        excluded.unvalued += 1;
        continue;
      }
      if (valuation.stale) staleValued += 1;
      const key = monthOf(new Date(tx.occurredAt));
      const running = byMonth.get(key);
      // A row outside the window cannot appear — the query is bounded — but
      // an unexpected key must not silently create a month the window does
      // not contain, which would make `perMonth.length` disagree with
      // `windowMonths` and the mean divide by the wrong number.
      if (!running) continue;
      byMonth.set(key, running.plus(valuation.amount));
      // After the bucket, not before: a row that fell outside the window is not
      // in `total`, so counting its provenance would break the sum.
      const source = answerSourceOf(tx);
      const bucket =
        source === 'user' ? 'user' : source === 'unattributed' ? 'unattributed' : 'automated';
      provenance[bucket] = provenance[bucket].plus(valuation.amount);
      counted += 1;
    }

    const amounts = months.map((month) => byMonth.get(month) as Decimal);
    const total = amounts.reduce((sum, amount) => sum.plus(amount), new Decimal(0));

    return {
      windowMonths,
      fromMonth: months[0] as string,
      toMonth: months[months.length - 1] as string,
      perMonth: months.map((month, index) => ({
        month,
        amount: (amounts[index] as Decimal).toString(),
      })),
      total: total.toString(),
      // Divided by the WINDOW, not by the months that happened to have a
      // movement: a month he spent nothing out of tracked accounts is a real
      // zero and belongs in the average. Dividing by non-empty months only
      // would report a higher burn the quieter he gets.
      perMonthMean: total.dividedBy(windowMonths).toString(),
      perMonthMedian: median(amounts).toString(),
      perMonthMin: amounts.reduce((a, b) => (a.lessThan(b) ? a : b)).toString(),
      perMonthMax: amounts.reduce((a, b) => (a.greaterThan(b) ? a : b)).toString(),
      countedTransactions: counted,
      excluded,
      provenance: {
        user: provenance.user.toString(),
        automated: provenance.automated.toString(),
        unattributed: provenance.unattributed.toString(),
      },
      staleValued,
    };
  }
}
