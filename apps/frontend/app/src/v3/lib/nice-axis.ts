/**
 * Round bounds and ticks for a value axis that is not anchored at zero.
 *
 * `['dataMin', 'dataMax']` put the net-worth axis's ends on whatever the
 * series happened to reach, so its ticks read "£200.9K £205.9K … £220.2K" with
 * a short last step (SC-1424). This widens the range outward to a whole
 * multiple of a 1, 2, 2.5 or 5 × 10ⁿ step, so every tick is a round figure and
 * every step is the same size. Still not zero-anchored: that would flatten a
 * net worth moving 120k → 124k into a straight line.
 */
export interface NiceAxis {
  domain: [number, number];
  ticks: number[];
}

const STEPS = [1, 2, 2.5, 5, 10];

export function niceAxis(values: readonly (number | null)[], count = 5): NiceAxis | null {
  const finite = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (finite.length === 0) return null;
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  if (max === min) return null;

  const raw = (max - min) / Math.max(count - 1, 1);
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = (STEPS.find((s) => s * magnitude >= raw) ?? 10) * magnitude;
  // Enough decimals for a 2.5 step, so float drift never prints 0.30000000004.
  const decimals = Math.max(0, 1 - Math.floor(Math.log10(step)));
  const round = (v: number) => Number(v.toFixed(decimals));

  const lo = round(Math.floor(min / step) * step);
  const hi = round(Math.ceil(max / step) * step);
  const ticks: number[] = [];
  for (let i = 0; lo + i * step <= hi + step / 2; i++) ticks.push(round(lo + i * step));
  return { domain: [lo, hi], ticks };
}
