import type { TokenPrice, TokenPriceGranularity } from '@scani/db/schema';

// In-memory price index that collapses a per-item price lookup into one
// prefetch. The repository fetches all rows for the relevant (tokenId,
// baseTokenId) pairs in one query; this class indexes them by pair +
// granularity and answers the same shape of closest-price-by-granularity
// query that PriceGraphService.tryDirect would otherwise issue per item.
//
// Two callers: the nightly rollup (~80k round-trips per backfill run) and
// the returns engine, where 537 sequential lookups were 51.2s of a 53.1s
// request (SC-471). `PriceGraphService.buildPriceLookup` builds both.
//
// Rows are pre-sorted by timestamp DESC inside each bucket so the
// lookup is `find first row with timestamp <= at`, O(N) worst case
// per bucket — but N is typically <1000 for the price feed of a
// single (token, base) pair over 5 years.
export class PriceLookup {
  private readonly byPair = new Map<string, TokenPrice[]>();
  private readonly byPairGran = new Map<string, TokenPrice[]>();
  private readonly covered: Set<string>;

  // `coveredPairs` is the pair set the prefetch QUERIED, which is not the
  // same as the pair set it found rows for. The difference is what makes a
  // preload safe to fall back from: a pair that was asked for and returned
  // nothing has no price, while a pair nobody asked for is a gap in the
  // preload, and answering `null` for the second is how a prefetch turns a
  // priced flow into an unvalued one with nothing on screen saying so.
  //
  // Omitted, it degrades to "every pair that produced a row" — which is what
  // callers predating this could distinguish anyway, and still strictly
  // better than treating every miss as an answer.
  constructor(
    rows: ReadonlyArray<TokenPrice>,
    coveredPairs?: ReadonlyArray<{ tokenId: string; baseTokenId: string }>
  ) {
    for (const row of rows) {
      const pairKey = `${row.tokenId}|${row.baseTokenId}`;
      pushTo(this.byPair, pairKey, row);
      const granKey = `${pairKey}|${row.granularity}`;
      pushTo(this.byPairGran, granKey, row);
    }
    for (const arr of this.byPair.values()) arr.sort(byTimestampDesc);
    for (const arr of this.byPairGran.values()) arr.sort(byTimestampDesc);
    this.covered = coveredPairs
      ? new Set(coveredPairs.map((pair) => `${pair.tokenId}|${pair.baseTokenId}`))
      : new Set(this.byPair.keys());
  }

  // Whether this index can answer for a pair at all. `false` means "ask the
  // database", not "there is no price".
  covers(tokenId: string, baseTokenId: string): boolean {
    return this.covered.has(`${tokenId}|${baseTokenId}`);
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
