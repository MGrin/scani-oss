import type { RouterOutputs } from '@/lib/trpc';

export type IncomeSummary = NonNullable<RouterOutputs['portfolio']['getIncome']['income']>;

/** The order every income figure is drawn and listed in. */
export const INCOME_GROUPS = ['dividend', 'interest', 'staking', 'rewards'] as const;
type IncomeGroup = (typeof INCOME_GROUPS)[number];

export interface IncomeView {
  /** UTC calendar days, `YYYY-MM-DD`: the window's bounds are 00:00Z and 23:59:59.999Z. */
  window: { from: string; to: string };
  months: { month: string; segments: Partial<Record<IncomeGroup, number>> }[];
  totals: { group: IncomeGroup; gross: number; withheld: number; net: number }[];
  securities: { label: string; payments: number; net: number }[];
  unpriced: number;
}

function utcDay(at: string | Date): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** A `YYYY-MM-DD` day as a local date, so formatting it names that same day in any zone. */
export function calendarDay(day: string): Date {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(year ?? 1970, (month ?? 1) - 1, date ?? 1);
}

/**
 * What the Home card draws from `portfolio.getIncome` (SC-1644), or `null`
 * when nothing was received: the card is not shown at all then, as the
 * returns card is not before there is history. Income that could not be
 * valued still shows the card, because an unpriced row is named, not hidden.
 */
export function toIncomeView(summary: IncomeSummary | null | undefined): IncomeView | null {
  if (!summary || (summary.months.length === 0 && summary.unpricedCount === 0)) return null;
  return {
    window: { from: utcDay(summary.window.from), to: utcDay(summary.window.to) },
    months: summary.months.map(({ month, groups }) => ({
      month,
      segments: Object.fromEntries(
        INCOME_GROUPS.flatMap((group) => {
          const amounts = groups[group];
          return amounts ? [[group, Number(amounts.net)]] : [];
        })
      ),
    })),
    totals: INCOME_GROUPS.flatMap((group) => {
      const amounts = summary.totals[group];
      return amounts
        ? [
            {
              group,
              gross: Number(amounts.gross),
              withheld: Number(amounts.withheld),
              net: Number(amounts.net),
            },
          ]
        : [];
    }),
    securities: summary.dividendsBySecurity.map((source) => ({
      label: source.symbol ?? source.isin ?? '—',
      payments: source.payments,
      net: Number(source.amounts.net),
    })),
    unpriced: summary.unpricedCount,
  };
}
