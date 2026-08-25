/**
 * The four windows a return can be asked over (SC-457).
 *
 * All boundaries are UTC and all ends are END of day, because that is what
 * `portfolio_value_daily` holds: `RollupPortfolioValueDailyUseCase` stamps
 * every historical day at 23:59:59.999Z. A window that ended at midnight would
 * exclude the very day it names.
 *
 * `'all'` has no start of its own — the earliest date the series can offer is
 * its start, and only the caller holding the series knows what that is. It
 * resolves to the epoch here and is narrowed to the first measured day by
 * `ReturnsService`.
 */

type ReturnWindowKind = 'ytd' | '1y' | 'all' | 'custom';

export type ReturnWindowRequest =
  | { kind: 'ytd' | '1y' | 'all' }
  | { kind: 'custom'; from: Date; to: Date };

export interface ResolvedReturnWindow {
  kind: ReturnWindowKind;
  /** Inclusive start, 00:00:00.000Z of its date. */
  from: Date;
  /** Inclusive end, 23:59:59.999Z of its date. */
  to: Date;
}

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

function startOfUtcDay(at: Date): Date {
  return new Date(`${at.toISOString().slice(0, 10)}T00:00:00.000Z`);
}

function endOfUtcDay(at: Date): Date {
  return new Date(`${at.toISOString().slice(0, 10)}T23:59:59.999Z`);
}

/**
 * `now` is a parameter rather than a call to `new Date()` so a YTD window is
 * testable and so two scopes computed in the same request share one boundary.
 */
export function resolveReturnWindow(request: ReturnWindowRequest, now: Date): ResolvedReturnWindow {
  const to = endOfUtcDay(now);
  if (request.kind === 'custom') {
    return { kind: 'custom', from: startOfUtcDay(request.from), to: endOfUtcDay(request.to) };
  }
  if (request.kind === 'ytd') {
    const year = now.getUTCFullYear();
    return { kind: 'ytd', from: new Date(`${year}-01-01T00:00:00.000Z`), to };
  }
  if (request.kind === '1y') {
    return { kind: '1y', from: startOfUtcDay(new Date(now.getTime() - YEAR_MS)), to };
  }
  return { kind: 'all', from: new Date(0), to };
}
