import Decimal from 'decimal.js';

export interface LoanTerms {
  principal: Decimal;
  annualRatePct: Decimal;
  termMonths: number;
  /** YYYY-MM-DD. Payment n falls n calendar months after it. */
  startDate: string;
  /** The contracted payment, when it differs from the level payment. */
  payment?: Decimal;
}

export interface ScheduleRow {
  n: number;
  date: string;
  payment: Decimal;
  interest: Decimal;
  principal: Decimal;
  remaining: Decimal;
}

export interface Projection {
  status: 'paid_off' | 'on_track' | 'ahead' | 'behind';
  payoffDate: string | null;
  remainingInterest: Decimal;
  /** Projected payoff month minus the scheduled maturity month. */
  monthsVsSchedule: number;
  converged: boolean;
}

const MAX_PERIODS = 1200;

const monthlyRate = (annualRatePct: Decimal) => annualRatePct.div(100).div(12);
const round = (v: Decimal, decimals: number) => v.toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP);

function paymentDate(startDate: string, n: number): string {
  const [y, m, day] = startDate.split('-').map(Number) as [number, number, number];
  const monthIndex = m - 1 + n;
  const year = y + Math.floor(monthIndex / 12);
  const month = monthIndex % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const date = new Date(Date.UTC(year, month, Math.min(day, lastDay)));
  return date.toISOString().slice(0, 10);
}

export function levelPayment(
  principal: Decimal,
  annualRatePct: Decimal,
  termMonths: number,
  decimals: number
): Decimal {
  const r = monthlyRate(annualRatePct);
  if (r.isZero()) return round(principal.div(termMonths), decimals);
  const growth = r.plus(1).pow(termMonths);
  return round(principal.times(r).times(growth).div(growth.minus(1)), decimals);
}

export function schedule(t: LoanTerms, decimals: number): ScheduleRow[] {
  const r = monthlyRate(t.annualRatePct);
  const level = t.payment ?? levelPayment(t.principal, t.annualRatePct, t.termMonths, decimals);
  const rows: ScheduleRow[] = [];
  let balance = t.principal;
  for (let n = 1; n <= t.termMonths && balance.greaterThan(0); n++) {
    const interest = round(balance.times(r), decimals);
    const owedWithInterest = balance.plus(interest);
    // The last payment settles the exact remainder, so rounding drift never leaves cents behind.
    const payment = n === t.termMonths ? owedWithInterest : Decimal.min(level, owedWithInterest);
    const principal = payment.minus(interest);
    balance = balance.minus(principal);
    rows.push({
      n,
      date: paymentDate(t.startDate, n),
      payment,
      interest,
      principal,
      remaining: balance,
    });
  }
  return rows;
}

/**
 * Walks the contracted payment forward from what is owed today. The schedule
 * says what was promised; `owedNow` says what happened, so a borrower who is
 * ahead pays off early and one who is behind runs past maturity.
 */
export function projectPayoff(
  t: LoanTerms,
  owedNow: Decimal,
  asOf: string,
  decimals: number
): Projection {
  if (!owedNow.greaterThan(0)) {
    return {
      status: 'paid_off',
      payoffDate: null,
      remainingInterest: new Decimal(0),
      monthsVsSchedule: 0,
      converged: true,
    };
  }
  const r = monthlyRate(t.annualRatePct);
  const level = t.payment ?? levelPayment(t.principal, t.annualRatePct, t.termMonths, decimals);
  // Per-period interest rounding drifts by at most half a minor unit, so over the
  // term the remainder at maturity can differ from zero by this much and still be on
  // schedule. A contracted payment rounded below the level one leaves a balloon the
  // schedule settles at maturity, so the same balloon is on schedule here too.
  const drift = new Decimal(10).pow(-decimals).times(t.termMonths);
  const lastRow = schedule(t, decimals).at(-1);
  const balloon = lastRow ? Decimal.max(lastRow.payment.minus(level), 0) : new Decimal(0);
  const settleWithin = balloon.plus(drift);

  let n = 1;
  while (n <= MAX_PERIODS && paymentDate(t.startDate, n) <= asOf) n++;

  let balance = owedNow;
  let remainingInterest = new Decimal(0);
  let last = n - 1;
  const end = n + MAX_PERIODS;
  for (; n < end && balance.greaterThan(0); n++) {
    const interest = round(balance.times(r), decimals);
    const owedWithInterest = balance.plus(interest);
    const settles =
      n === t.termMonths && owedWithInterest.minus(level).lessThanOrEqualTo(settleWithin);
    const payment = settles ? owedWithInterest : Decimal.min(level, owedWithInterest);
    const principal = payment.minus(interest);
    if (!principal.greaterThan(0)) {
      return {
        status: 'behind',
        payoffDate: null,
        remainingInterest,
        monthsVsSchedule: 0,
        converged: false,
      };
    }
    remainingInterest = remainingInterest.plus(interest);
    balance = balance.minus(principal);
    last = n;
  }

  if (balance.greaterThan(0)) {
    return {
      status: 'behind',
      payoffDate: null,
      remainingInterest,
      monthsVsSchedule: 0,
      converged: false,
    };
  }
  const monthsVsSchedule = last - t.termMonths;
  const status = monthsVsSchedule < 0 ? 'ahead' : monthsVsSchedule > 0 ? 'behind' : 'on_track';
  return {
    status,
    payoffDate: paymentDate(t.startDate, last),
    remainingInterest,
    monthsVsSchedule,
    converged: true,
  };
}

export function cardUtilization(
  owed: Decimal,
  limit: Decimal | null
): { utilization: Decimal | null; available: Decimal | null } {
  if (limit === null || !limit.greaterThan(0)) return { utilization: null, available: null };
  return { utilization: owed.div(limit), available: limit.minus(owed) };
}
