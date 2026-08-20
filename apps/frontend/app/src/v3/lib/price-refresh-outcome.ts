import type { TFunction } from 'i18next';
import { formatRelative } from './relative-time';

/**
 * What "Refresh price" is allowed to claim once its job lands.
 *
 * The job returns `success: true` whenever it ran without throwing, and both
 * shells translated that into a green "Price refreshed" — over a price line
 * that still read `25m ago`, one row below, on the same screen (SC-148).
 *
 * Three outcomes hide behind that one boolean, and only the first is a refresh:
 *
 * - a provider was called and the stored price moved;
 * - nothing was fetched, and the figure on screen is the one that was already
 *   stored. That covers both a hit inside the one-hour live window (correct
 *   behaviour — a manual refresh must not spend the rate-limit budget on a
 *   price that is already current) and a stale fallback when every provider
 *   declined. Neither is a refresh, and the age line one row below
 *   contradicted the claim that it was;
 * - no provider had a quote at all, `price: null`, and the figure is unchanged.
 *   That third one was reported as a success too, which is the falsest of them.
 *
 * v2's copy stays in v2 and dies with it (SC-320): only the v3 chunk registers
 * `v3.*`, so one shared module calling `t()` would render raw keys under `/v2`.
 */

export interface PriceRefreshReport {
  price?: string | null;
  /** False when nothing was fetched and this is the stored price — see
   *  `PricingService.fetchAndStoreFreshPrice`. */
  fetched?: boolean;
  /** When the returned price was recorded, not when the job ran. */
  timestamp?: string;
}

export interface PriceRefreshOutcome {
  /** `already-current` is the name of the branch, not of the claim it makes —
   *  see the message it builds, which does not assert freshness. */
  kind: 'updated' | 'already-current' | 'no-price';
  message: string;
}

/**
 * @param symbol upper-cased ticker. Required here, unlike v2's, whose null
 *   branch spoke about "the price" for a detail page that had no holding in
 *   hand. v3 subscribes per holding — `useHoldingRefresh` always knows the
 *   symbol — so the nullable half was a sentence no v3 reader could reach, and
 *   translating it would have added three keys nothing renders.
 *
 * A result the caller could not narrow — an older job row, or a shape that
 * changed — is read as `updated`. That is the pre-existing behaviour and the
 * only safe default: the alternative is telling someone nothing happened when
 * it may have.
 */
export function describePriceRefresh(
  t: TFunction,
  report: PriceRefreshReport | null | undefined,
  symbol: string
): PriceRefreshOutcome {
  // `'price' in report`, not `report.price == null`: a result with no `price`
  // key at all is a shape this function cannot read, and reading it as "no
  // provider had a quote" would be its own false claim. Only a key that IS
  // there and IS null is the job saying it found nothing.
  if (report && 'price' in report && report.price == null) {
    return {
      kind: 'no-price',
      message: t('v3.holdings.refresh.outcome.noPrice', { symbol }),
    };
  }

  if (report?.fetched === false) {
    // "No new price", NOT "already current". Two paths reach `fetched: false`
    // and only one of them means fresh: a hit inside the one-hour live window,
    // and a stale-fallback when every provider declined. Verified against a
    // three-hour-old row — it came back `fetched: false` with the old
    // timestamp, and "is already current — fetched 3h ago" contradicts itself
    // in the same breath. Stating what happened survives both, and stating the
    // age lets the reader judge freshness instead of being told it.
    const age = report.timestamp ? formatRelative(t, report.timestamp) : null;
    return {
      kind: 'already-current',
      message: age
        ? t('v3.holdings.refresh.outcome.storedWithAge', { symbol, age })
        : t('v3.holdings.refresh.outcome.stored', { symbol }),
    };
  }

  return { kind: 'updated', message: t('v3.holdings.refresh.outcome.updated', { symbol }) };
}
