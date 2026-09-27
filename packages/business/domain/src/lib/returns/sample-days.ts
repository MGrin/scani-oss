/**
 * Thin a window's measured days down to what a chart can ask prices for.
 *
 * Every sampled day costs one conversion per benchmark, so an `'all'` window
 * on a five-year portfolio would be thousands of round trips for a line about
 * 600 pixels wide. Both ends are kept whatever the cap: the last point is the
 * figure printed above the chart, and a chart that ends somewhere else is the
 * disagreement this card was built to remove.
 */
export function sampleDays(days: string[], cap: number): string[] {
  if (days.length <= cap || days.length === 0) return days;

  const step = Math.ceil(days.length / cap);
  const sampled: string[] = [];
  for (let i = 0; i < days.length; i += step) {
    sampled.push(days[i] as string);
  }

  const last = days[days.length - 1] as string;
  if (sampled[sampled.length - 1] !== last) sampled.push(last);
  return sampled;
}
