import type { HoldingValueQuote } from '@scani/db/schema';
import { Decimal } from '@scani/shared';

/** In the order they are tried: the first that holds names the difference. */
const VALUE_DIFF_CATEGORIES = [
  'quote-missing',
  'quote-metadata-differs',
  'quote-freshness-differs',
  'transit-value-differs',
  'transit-cache-missing',
  'not-valued',
  'no-longer-priced',
  'price-moved-since',
  'same-reading-value-differs',
] as const;
export type ValueDiffCategory = (typeof VALUE_DIFF_CATEGORIES)[number];

export type ValueComparator = 'cache-vs-live';

export interface CachedValue {
  value: string | null;
  pricedAt: Date | null;
  quote?: HoldingValueQuote | null;
}

export interface LiveValue {
  value: string | null;
  /** The reading's instant; the run's own instant for the base currency itself. */
  readingAt: Date | null;
  price: string | null;
  balance: string;
  /** The holding is of the owner's base currency, whose identity price has no reading. */
  isBase: boolean;
  baseTokenId?: string;
  source?: string;
  stale?: boolean;
}

/**
 * A holding's cached value beside the live valuation at `at`, exact. `null`
 * when they agree. `same-reading-value-differs` is the one a reader must open:
 * the price read is the one cached, so either the balance moved around the
 * writer, a reading was rewritten in place, or the product differs.
 */
export function compareValue(
  cached: CachedValue,
  live: LiveValue,
  at: Date
): {
  comparator: ValueComparator;
  category: ValueDiffCategory;
  at: Date;
  engineValue: string | null;
  legacyValue: string | null;
  detail: Record<string, unknown>;
} | null {
  const valuesAgree =
    (cached.value === null && live.value === null) ||
    (cached.value !== null && live.value !== null && new Decimal(cached.value).eq(live.value));
  if (valuesAgree) {
    if (cached.quote === undefined) return null;
    const quote = cached.quote;
    const category =
      quote === null || quote.version !== 1 || quote.baseTokenId !== live.baseTokenId
        ? 'quote-missing'
        : quote.price !== live.price ||
            (!live.isBase &&
              (quote.source !== (live.source ?? null) ||
                cached.pricedAt?.getTime() !== live.readingAt?.getTime()))
          ? 'quote-metadata-differs'
          : live.price !== null &&
              (quote.staleAfter !== null && at > new Date(quote.staleAfter)) !== live.stale
            ? 'quote-freshness-differs'
            : null;
    return category === null
      ? null
      : {
          comparator: 'cache-vs-live',
          category,
          at,
          engineValue: cached.value,
          legacyValue: live.value,
          detail: {
            quote,
            livePrice: live.price,
            liveSource: live.source ?? null,
            liveStale: live.stale,
            cachedPricedAt: cached.pricedAt?.toISOString() ?? null,
            liveReadingAt: live.readingAt?.toISOString() ?? null,
          },
        };
  }
  const category: ValueDiffCategory =
    cached.value === null
      ? 'not-valued'
      : live.value === null
        ? 'no-longer-priced'
        : !live.isBase && cached.pricedAt?.getTime() !== live.readingAt?.getTime()
          ? 'price-moved-since'
          : 'same-reading-value-differs';
  return {
    comparator: 'cache-vs-live',
    category,
    at,
    engineValue: cached.value,
    legacyValue: live.value,
    detail: {
      cachedPricedAt: cached.pricedAt?.toISOString() ?? null,
      liveReadingAt: live.readingAt?.toISOString() ?? null,
      livePrice: live.price,
      balance: live.balance,
    },
  };
}
