import Decimal from 'decimal.js';

export interface CounterfactualInput {
  /** Days of the window, ascending, `YYYY-MM-DD`. */
  days: string[];
  /** One unit of the benchmark in the reader's base currency, per day. */
  prices: Map<string, Decimal>;
  /** What the portfolio was worth when the window opened. */
  openingValue: Decimal;
  /** Net external flow on a day: positive in, negative out. */
  flowsByDay: Map<string, Decimal>;
}

/**
 * The reader's own money, put into one benchmark instead, valued each day.
 *
 * Money waits rather than vanishing when a day has no price: a benchmark whose
 * history starts inside the window would otherwise compare the reader against
 * a smaller position than they actually funded, which reads as the benchmark
 * doing worse than it did. A day with no price yields no point at all, because
 * a straight line drawn through an unknown price is a claim we cannot support.
 */
export function counterfactualSeries(input: CounterfactualInput): Map<string, Decimal> {
  const series = new Map<string, Decimal>();
  let units = new Decimal(0);
  let waiting = input.openingValue;

  for (const day of input.days) {
    const price = input.prices.get(day);
    const flow = input.flowsByDay.get(day) ?? new Decimal(0);

    if (!price || price.lte(0)) {
      waiting = waiting.plus(flow);
      continue;
    }

    if (!waiting.isZero()) {
      units = Decimal.max(new Decimal(0), units.plus(waiting.div(price)));
      waiting = new Decimal(0);
    }

    if (flow.gt(0)) {
      units = units.plus(flow.div(price));
    } else if (flow.lt(0)) {
      // Selling more than the position holds empties it; a benchmark cannot
      // be short, and a negative line would be read as a loss that happened.
      units = Decimal.max(new Decimal(0), units.minus(flow.abs().div(price)));
    }

    series.set(day, units.mul(price));
  }

  return series;
}
