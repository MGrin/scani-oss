import { type MoneyAttributionRates, splitChangeIntoMoney } from '@scani/shared';
import Decimal from 'decimal.js';
import type { BenchmarkKey } from './benchmarks';
import { counterfactualSeries } from './counterfactual';

/**
 * The returns card, in money (SC-1297).
 *
 * Everything here is assembled from figures the returns engine already
 * produced — the measured daily series, its net external flow, its
 * asset/currency rates — plus one price per benchmark per day. Nothing is
 * re-valued: a second valuation path is what SC-60 exists to prevent, and a
 * chart that disagreed with the number printed above it would be that defect
 * in its most visible form.
 */

export interface ComparisonInput {
  series: { date: string; value: string; netExternalFlow: string }[];
  netExternalFlow: string;
  attribution: MoneyAttributionRates | null;
  /** Benchmark key → that benchmark's price in base currency, by day. */
  benchmarkPrices: Map<string, Map<string, Decimal>>;
}

export interface ComparisonCard {
  /** Null values mean the window measured nothing — an absence, not a zero. */
  headline: { change: string | null; from: string | null; to: string | null };
  attribution: {
    contributions: string;
    gain: string;
    market: string | null;
    currency: string | null;
    crossEffect: string | null;
  };
  chart: { date: string; portfolio: string; benchmarks: Record<string, string | undefined> }[];
  /** Ahead (+) or behind (−) each benchmark, in money, at the window's end. */
  gaps: { key: BenchmarkKey | string; money: string; benchmarkValue: string }[];
}

const EMPTY: ComparisonCard = {
  headline: { change: null, from: null, to: null },
  attribution: { contributions: '0', gain: '0', market: null, currency: null, crossEffect: null },
  chart: [],
  gaps: [],
};

export function buildComparison(input: ComparisonInput): ComparisonCard {
  if (input.series.length === 0) return EMPTY;

  const first = input.series[0] as ComparisonInput['series'][number];
  const last = input.series[input.series.length - 1] as ComparisonInput['series'][number];
  const days = input.series.map((point) => point.date);
  const openingValue = new Decimal(first.value);
  const closingValue = new Decimal(last.value);

  // The window's opening value is already invested, so it is never a flow.
  // Counting it as one would buy the whole portfolio into the benchmark twice.
  const flowsByDay = new Map(
    input.series.slice(1).map((point) => [point.date, new Decimal(point.netExternalFlow)])
  );

  const split = splitChangeIntoMoney({
    openingValue,
    closingValue,
    netFlow: new Decimal(input.netExternalFlow),
    attribution: input.attribution,
  });

  const counterfactuals = new Map<string, Map<string, Decimal>>();
  for (const [key, prices] of input.benchmarkPrices) {
    if (prices.size === 0) continue;
    counterfactuals.set(key, counterfactualSeries({ days, prices, openingValue, flowsByDay }));
  }

  const chart = input.series.map((point) => {
    const benchmarks: Record<string, string | undefined> = {};
    for (const [key, values] of counterfactuals) {
      benchmarks[key] = values.get(point.date)?.toString();
    }
    return { date: point.date, portfolio: point.value, benchmarks };
  });

  const gaps: ComparisonCard['gaps'] = [];
  for (const [key, values] of counterfactuals) {
    const endValue = values.get(last.date);
    if (!endValue) continue;
    gaps.push({
      key,
      money: closingValue.minus(endValue).toString(),
      benchmarkValue: endValue.toString(),
    });
  }

  return {
    headline: {
      change: closingValue.minus(openingValue).toString(),
      from: first.date,
      to: last.date,
    },
    attribution: {
      contributions: split.contributions.toString(),
      gain: split.gain.toString(),
      market: split.market?.toString() ?? null,
      currency: split.currency?.toString() ?? null,
      crossEffect: split.crossEffect?.toString() ?? null,
    },
    chart,
    gaps,
  };
}
