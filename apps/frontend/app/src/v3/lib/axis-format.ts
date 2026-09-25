/**
 * How a currency axis prints its ticks, so neighbouring ticks cannot share a
 * label. A compact figure keeps one decimal of its unit — 1,432 is "$1.4K" —
 * so a first holding moving between $1,433 and $1,462 printed "$1.5K $1.5K
 * $1.4K $1.4K $1.4K": five ticks, two labels (SC-1138 new-user walk,
 * 2026-09-19).
 *
 * Compact with one decimal while that separates one tick step from the next.
 * In the thousands, where it does not, whole units instead — "$1,433" is
 * shorter than the same figure in thousands to three decimals, and says the same. Above that, as many decimals of
 * the unit as the step needs, capped at 3.
 */
export interface AxisFormat {
  compact: boolean;
  decimals?: number;
}

const COMPACT: AxisFormat = { compact: true };

export function axisFormat(values: readonly (number | null)[], ticks = 5): AxisFormat {
  // A gap in the series is `null`; it has no height to separate.
  const finite = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (finite.length === 0) return COMPACT;
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const magnitude = Math.max(Math.abs(min), Math.abs(max));
  if (magnitude < 1_000 || max === min) return COMPACT;
  const unit = magnitude >= 1e12 ? 1e12 : magnitude >= 1e9 ? 1e9 : magnitude >= 1e6 ? 1e6 : 1e3;
  const step = (max - min) / Math.max(ticks - 1, 1) / unit;
  const needed = Math.ceil(-Math.log10(step));
  if (needed <= 1) return COMPACT;
  if (unit === 1e3) return { compact: false, decimals: 0 };
  return { compact: true, decimals: Math.min(needed, 3) };
}
