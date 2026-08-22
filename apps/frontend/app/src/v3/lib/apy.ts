import {
  Decimal,
  formatNumber,
  moneyDecimals,
  monthName,
  PAYOUTS_PER_YEAR,
  PayoutFrequency,
} from '@scani/shared';
import type { TFunction } from 'i18next';
import { daysInMonth, payoutScheduleLabel } from './holdings';

/**
 * The interest form, as the part of it that is not a DOM (SC-320).
 *
 * v2's `ApyConfigDialog` answers every question about this form inline in its
 * JSX — which fields apply, whether the button may be pressed, what the API
 * payload is — and that is why two of its answers are wrong in ways no test
 * could reach. The rules live here instead, next to a test that states them.
 *
 * Everything below mirrors a rule that already exists on the server, and the
 * mirroring is deliberate rather than duplication for its own sake: the DTO
 * (`UpsertHoldingApyConfigDto`) rejects a bad draft with a 400 whose message is
 * about a field path, and the payout job (`ApplyApyPayoutsUseCase`) is where
 * the schedule actually means something. A form that cannot say the same things
 * first can only relay the server's sentence after the fact.
 */

export type PayoutFrequencyCode = PayoutFrequency;

/**
 * The frequencies the picker offers, taken from the DTO's own enum rather than
 * retyped. v2 keeps a hand-written list beside it, so a frequency added to the
 * enum would be accepted by the API and unofferable in the UI — silently, and
 * in the direction that is hardest to notice.
 */
export const PAYOUT_FREQUENCIES: readonly PayoutFrequencyCode[] = PayoutFrequency.options;

/** Sentence-case name for the picker. The *schedule* sentences ("Monthly on day
 *  1") are `payoutScheduleLabel`'s and live in `lib/holdings.ts`; these are the
 *  bare names, which is a different string even where it is the same word. */
export function frequencyLabelKey(frequency: PayoutFrequencyCode): string {
  return `v3.holdings.apy.frequency.${frequency}`;
}

/** Which of the three schedule fields this frequency actually uses — the same
 *  three conditions the DTO's `superRefine` enforces, in the same order. */
export function needsDayOfWeek(frequency: PayoutFrequencyCode): boolean {
  return frequency === 'weekly';
}

export function needsDayOfMonth(frequency: PayoutFrequencyCode): boolean {
  return frequency === 'monthly' || frequency === 'yearly';
}

export function needsMonth(frequency: PayoutFrequencyCode): boolean {
  return frequency === 'yearly';
}

export interface ApyDraft {
  /** Canonical `AmountInput` string — `'4.5'`, never `'4,5'` or `'4.5%'`. */
  rate: string;
  frequency: PayoutFrequencyCode;
  dayOfWeek: number;
  /** Canonical `AmountInput` string, whole numbers only. */
  dayOfMonth: string;
  month: number;
}

/**
 * The rate as a number the API will accept, or null.
 *
 * The bounds are the DTO's exactly — above 0, up to and including 100 — and
 * they are checked *here* rather than at the keystroke, which is the fix for
 * v2's most user-visible defect. v2 hands `react-number-format` an `isAllowed`
 * of `floatValue > 0`, and that predicate runs on every intermediate value: the
 * `0` in `0.5` fails it, so the keystroke is swallowed and a rate below 1%
 * cannot be typed at all. A savings account at 0.5% is not an edge case.
 *
 * Rejecting a *value* and rejecting a *keystroke* are different things, and
 * only the first one can be explained to the reader.
 */
export function parseRatePct(value: string): number | null {
  if (value.trim() === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return parsed > 0 && parsed <= 100 ? parsed : null;
}

/**
 * The day of the month as an integer 1-31, or null.
 *
 * Null rather than a default, which is v2's second defect: it runs
 * `Number.parseInt('')`, gets `NaN`, and substitutes `1`. Clearing the field to
 * retype `15` and submitting a keystroke early therefore books the payout on
 * the 1st, with nothing on screen having said so.
 */
export function parseDayOfMonth(value: string): number | null {
  if (value.trim() === '') return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return null;
  return parsed >= 1 && parsed <= 31 ? parsed : null;
}

/** Ordered top-to-bottom as the fields are, so the sentence reads as a path
 *  down the form rather than as a set. */
export function apyBlockers(t: TFunction, draft: ApyDraft): string[] {
  const blockers: string[] = [];
  if (parseRatePct(draft.rate) === null) blockers.push(t('v3.holdings.apy.needRate'));
  if (needsDayOfMonth(draft.frequency) && parseDayOfMonth(draft.dayOfMonth) === null) {
    blockers.push(t('v3.holdings.apy.needDayOfMonth'));
  }
  return blockers;
}

export interface ApyConfigInput {
  annualRatePct: string;
  payoutFrequency: PayoutFrequencyCode;
  payoutDayOfWeek: number | null;
  payoutDayOfMonth: number | null;
  payoutMonth: number | null;
}

/**
 * The draft as the mutation's payload, or null when it is not submittable.
 *
 * One function rather than a boolean guard beside a separate builder: the two
 * cannot then disagree about whether this draft is ready, which is the failure
 * mode where a form looks submittable and the server answers with a 400.
 *
 * The three nullable fields are nulled by *frequency*, not by whether the user
 * happened to touch them — a weekly schedule must not carry the day-of-month
 * left over from the monthly one the reader looked at first.
 */
export function apyConfigInput(draft: ApyDraft): ApyConfigInput | null {
  const rate = parseRatePct(draft.rate);
  if (rate === null) return null;

  const dayOfMonth = parseDayOfMonth(draft.dayOfMonth);
  if (needsDayOfMonth(draft.frequency) && dayOfMonth === null) return null;

  return {
    // The string the reader typed, not `String(rate)`: the API takes a decimal
    // string and re-parsing through a float is where a long fraction picks up
    // a binary tail it never had on screen.
    annualRatePct: draft.rate.trim(),
    payoutFrequency: draft.frequency,
    payoutDayOfWeek: needsDayOfWeek(draft.frequency) ? draft.dayOfWeek : null,
    payoutDayOfMonth: needsDayOfMonth(draft.frequency) ? dayOfMonth : null,
    payoutMonth: needsMonth(draft.frequency) ? draft.month : null,
  };
}

/** What the form opens with. Monday and the 1st are v2's defaults, kept: they
 *  are the only two values on this form nobody has an opinion about. */
export function apyDraftFromConfig(config?: {
  annualRatePct: string;
  payoutFrequency: string;
  payoutDayOfWeek: number | null;
  payoutDayOfMonth: number | null;
  payoutMonth: number | null;
}): ApyDraft {
  const frequency = PAYOUT_FREQUENCIES.find((code) => code === config?.payoutFrequency);
  return {
    rate: config?.annualRatePct ?? '',
    frequency: frequency ?? 'monthly',
    dayOfWeek: config?.payoutDayOfWeek ?? 1,
    dayOfMonth: String(config?.payoutDayOfMonth ?? 1),
    month: config?.payoutMonth ?? 1,
  };
}

/**
 * What the next payout is worth at today's balance, in the holding's own units.
 *
 * The arithmetic is the job's first iteration exactly — `balance × rate ÷
 * payouts per year`, over the shared `PAYOUTS_PER_YEAR` rather than a second
 * copy of that table. *Next*, not *each*: the job compounds, so every payout
 * after this one is computed against a balance this one has already moved.
 *
 * It answers the question the form otherwise leaves the reader to do in their
 * head. An annual percentage is not a quantity, and "4.5%, daily" on a current
 * account is a different order of magnitude per payout from "4.5%, yearly" on
 * the same one — which is the whole reason the frequency field is there.
 */
export function nextPayoutAmount(
  balance: Decimal.Value,
  ratePct: number,
  frequency: PayoutFrequencyCode
): number {
  return new Decimal(balance)
    .mul(new Decimal(ratePct).div(100))
    .div(PAYOUTS_PER_YEAR[frequency])
    .toNumber();
}

/**
 * Whether a monthly schedule on this day will land early in some months.
 *
 * The job clamps with `Math.min(dayOfMonth, daysInMonth)`, so the 31st is paid
 * on the 30th in April and on the 28th or 29th in February. That is the right
 * behaviour and the wrong silence: v2 accepts 31 with no indication that seven
 * months of the year will pay on a different date than the one on screen.
 */
export function monthlyDayClamps(dayOfMonth: number | null): boolean {
  return dayOfMonth !== null && dayOfMonth > 28;
}

/**
 * Whether a yearly schedule on this day and month is past the end of that
 * month. February 30th is accepted by the DTO and paid on the 28th — or the
 * 29th, which is why the note this drives says "the last day" rather than
 * naming one.
 *
 * A leap year is the reason the *year* is a parameter: February 29th clamps in
 * three years out of four and not in the fourth, so asking about one hard-coded
 * year would call it clamped when it is not, or the reverse.
 */
export function yearlyDayClamps(dayOfMonth: number | null, month: number, year: number): boolean {
  return dayOfMonth !== null && dayOfMonth > daysInMonth(year, month);
}

/**
 * The clamp note under the day-of-month field, or null when nothing is clamped.
 *
 * Two sentences rather than one because the two cases are different facts. A
 * *monthly* schedule on the 31st is right in seven months and early in five, so
 * the note is about months in general. A *yearly* one is about a single named
 * month, and naming it is the whole content — "February ends before that" tells
 * the reader something "shorter months pay early" does not.
 */
export function apyDayNote(t: TFunction, draft: ApyDraft, year: number): string | null {
  const dayOfMonth = parseDayOfMonth(draft.dayOfMonth);
  if (needsMonth(draft.frequency)) {
    return yearlyDayClamps(dayOfMonth, draft.month, year)
      ? t('v3.holdings.apy.pastMonthEnd', { month: monthName(draft.month) })
      : null;
  }
  if (!needsDayOfMonth(draft.frequency)) return null;
  return monthlyDayClamps(dayOfMonth) ? t('v3.holdings.apy.shortMonths') : null;
}

/**
 * The summary under the fields: the schedule as the peek will state it back,
 * and what the next payout is worth. Null while the draft is not yet a
 * schedule — a sentence built from a half-typed rate is worse than no sentence,
 * because it reads as a claim about a number the reader has not finished.
 *
 * `moneyDecimals` of the PAYOUT, not `quantityDecimals` of the balance: a daily
 * payout on a five-figure balance is a couple of units, and the balance's own
 * precision would round it to a whole number of them.
 */
export function apyPreviewSentence(
  t: TFunction,
  draft: ApyDraft,
  holding: { amount: Decimal.Value; symbol: string },
  year: number = new Date().getUTCFullYear()
): string | null {
  const rate = parseRatePct(draft.rate);
  if (rate === null) return null;
  const dayOfMonth = parseDayOfMonth(draft.dayOfMonth);
  if (needsDayOfMonth(draft.frequency) && dayOfMonth === null) return null;

  const payout = nextPayoutAmount(holding.amount, rate, draft.frequency);
  return t('v3.holdings.apy.preview', {
    schedule: payoutScheduleLabel(
      t,
      draft.frequency,
      draft.dayOfWeek,
      dayOfMonth,
      draft.month,
      year
    ),
    amount: formatNumber(payout, { decimals: moneyDecimals(payout) }),
    symbol: holding.symbol,
  });
}
