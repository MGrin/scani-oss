import type { TokenPrice, TokenPriceGranularity } from '@scani/db/schema';

// In-memory price index used by the rollup hot-path to skip ~80k DB
// round-trips per backfill run. The repository fetches all rows for
// the relevant (tokenId, baseTokenId) pairs in one query; this class
// indexes them by pair + granularity and answers the same shape of
// closest-price-by-granularity query that PriceGraphService.tryDirect
// would otherwise issue per-(day, holding).
//
// Rows are pre-sorted by timestamp DESC inside each bucket so the
// lookup is `find first row with timestamp <= at`, O(N) worst case
// per bucket — but N is typically <1000 for the price feed of a
// single (token, base) pair over 5 years.
export class PriceLookup {
  private readonly byPair = new Map<string, TokenPrice[]>();
  private readonly byPairGran = new Map<string, TokenPrice[]>();

  constructor(rows: ReadonlyArray<TokenPrice>) {
    for (const row of rows) {
      const pairKey = `${row.tokenId}|${row.baseTokenId}`;
      pushTo(this.byPair, pairKey, row);
      const granKey = `${pairKey}|${row.granularity}`;
      pushTo(this.byPairGran, granKey, row);
    }
    for (const arr of this.byPair.values()) arr.sort(byTimestampDesc);
    for (const arr of this.byPairGran.values()) arr.sort(byTimestampDesc);
  }

  // Mirrors TokenPriceRepository.findClosestPriceByGranularity but
  // operates on the in-memory dataset.
  findClosestByGranularity(
    tokenId: string,
    baseTokenId: string,
    at: Date,
    prefer: TokenPriceGranularity | null
  ): TokenPrice | null {
    const pairKey = `${tokenId}|${baseTokenId}`;
    if (prefer) {
      const granBucket = this.byPairGran.get(`${pairKey}|${prefer}`);
      if (granBucket) {
        const hit = pickClosestAtOrBefore(granBucket, at);
        if (hit) return hit;
      }
    }
    const anyBucket = this.byPair.get(pairKey);
    if (!anyBucket) return null;
    return pickClosestAtOrBefore(anyBucket, at);
  }
}

function pickClosestAtOrBefore(rows: TokenPrice[], at: Date): TokenPrice | null {
  const ts = at.getTime();
  for (const row of rows) {
    if (row.timestamp.getTime() <= ts) return row;
  }
  return null;
}

function byTimestampDesc(a: TokenPrice, b: TokenPrice): number {
  return b.timestamp.getTime() - a.timestamp.getTime();
}

function pushTo<T>(map: Map<string, T[]>, key: string, value: T): void {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}
