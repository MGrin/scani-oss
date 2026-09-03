import { MAX_DAILY_PRICE_AGE_MS, MAX_INTRADAY_PRICE_AGE_MS } from './constants';

/**
 * Whether a price is too far from the instant it is being used for to be
 * presented as a quote from that instant.
 *
 * Lifted out of `PriceGraphService`, which had it inline, because a second
 * caller now needs the identical answer: the live holdings valuation reads a
 * cached `token_prices` row directly and never goes through `convert()`, so
 * without this it had no way to say a price was old that did not amount to
 * choosing a threshold of its own. Both constants are unchanged and both keep
 * their reasoning where it is written down — see `constants.ts`.
 *
 * `granularity` is what selects the cap, and the two callers know it by
 * different routes. `PriceGraphService` passes the granularity it ASKED for,
 * because the row it gets back is the one that preference selected. The
 * holdings path passes the granularity of the row it FOUND, because it asked
 * for nothing in particular and took the latest of any kind. Neither is a
 * different rule: the question in both cases is whether this is a
 * daily-granularity close, which is legitimately weekly for a thin pair.
 *
 * Anything that is not `'daily'` — including a rate the graph derived, which
 * is not a `token_prices` row and carries no granularity at all — gets the
 * intraday cap. That is the same default `convert()` has always applied when
 * no preference was expressed, and it is the stricter of the two, so an
 * unknown granularity errs toward saying the price is old rather than toward
 * silence.
 */
export function isPriceStale(
  effectiveAt: Date,
  at: Date,
  granularity: string | null | undefined
): boolean {
  const cap = granularity === 'daily' ? MAX_DAILY_PRICE_AGE_MS : MAX_INTRADAY_PRICE_AGE_MS;
  return at.getTime() - effectiveAt.getTime() > cap;
}
