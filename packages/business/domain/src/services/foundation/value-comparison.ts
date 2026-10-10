import { Decimal } from '@scani/shared';

/** In the order they are tried: the first that holds names the difference. */
const VALUE_DIFF_CATEGORIES = [
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
}

export interface LiveValue {
  value: string | null;
  /** The reading's instant; the run's own instant for the base currency itself. */
  readingAt: Date | null;
  price: string | null;
  balance: string;
  /** The holding is of the owner's base currency, whose identity price has no reading. */
  isBase: boolean;
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
  if (cached.value === null && live.value === null) return null;
  if (cached.value !== null && live.value !== null && new Decimal(cached.value).eq(live.value)) {
    return null;
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
