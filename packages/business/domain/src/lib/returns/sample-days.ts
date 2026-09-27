/** Keep both endpoints while thinning only the chart output, never its funding history. */
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
