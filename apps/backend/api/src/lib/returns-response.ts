import type { ReturnAttribution } from '@scani/domain/lib/returns/fx-attribution';
import type { TwrResult } from '@scani/domain/lib/returns/twr';
import type { ReturnsResult } from '@scani/domain/services';

/**
 * What a returns response owes the wire (SC-471, extended by SC-458).
 *
 * `TwrResult.periods` carries one entry per measured day, each with six
 * full-precision decimal strings. Over an `all` window on the account with
 * real history that is 491 entries: the response is 93,505 bytes and 744 of
 * them are everything else, so the series is 99.2% of what was sent on every
 * call for two numbers on a screen.
 *
 * `ReturnAttribution.periods` is the same series again, one entry per
 * sub-period with the asset and currency legs — so it would roughly double
 * what SC-471 measured if it travelled by default. It is gated by the SAME
 * flag rather than one of its own: they share their boundaries, and a client
 * that asked for one and silently got half of the other would have no way to
 * line them up.
 *
 * Both are still COMPUTED, always. The sub-period boundaries are what SC-458
 * attributes FX across and what SC-464 chains a benchmark over, and neither
 * can re-derive them from the cumulative scalar. What changes is only who is
 * sent them: an internal caller holds the `ReturnsResult` and has them; a
 * browser asks for them with `includePeriods`.
 */
export type ReturnsResponse = Omit<ReturnsResult, 'twr' | 'attribution'> & {
  twr: Omit<TwrResult, 'periods'> | null;
  attribution: Omit<ReturnAttribution, 'periods'> | null;
};

/**
 * The same result with both sub-period breakdowns DROPPED, not emptied.
 *
 * An empty `periods` array is a claim that the window had no sub-periods,
 * which is a different and false statement. Removing the key says only that
 * it was not asked for, so a client reading `periods?.length` gets
 * `undefined` rather than a confident `0`. The counts beside them —
 * `measuredPeriods`, `skippedPeriods`, `attributedPeriods`,
 * `unattributedPeriods` — still travel, so how many there were is never in
 * doubt.
 */
export function withoutPeriodSeries(result: ReturnsResult): ReturnsResponse {
  return {
    ...result,
    twr: result.twr === null ? null : omitPeriods(result.twr),
    attribution: result.attribution === null ? null : omitPeriods(result.attribution),
  };
}

function omitPeriods<T extends { periods: unknown }>(value: T): Omit<T, 'periods'> {
  const { periods, ...rest } = value;
  void periods;
  return rest;
}
