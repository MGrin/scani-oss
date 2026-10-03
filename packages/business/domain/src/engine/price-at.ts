import { Decimal } from '@scani/shared';
import {
  type AssetClass,
  PRICE_GRANULARITIES,
  type PriceAsset,
  type PriceAt,
  type PriceEvidence,
  type PricePath,
  type PriceReading,
} from './types';

const HOUR_MS = 3_600_000;

export const STALENESS_HORIZON_MS: Readonly<Record<AssetClass, number | null>> = Object.freeze({
  crypto: 48 * HOUR_MS,
  // A weekend plus a holiday.
  fiat: 120 * HOUR_MS,
  stock: 120 * HOUR_MS,
  // Manual prices are steps: the last one stands until the next.
  custom: null,
  // An unclassified asset errs to the strict side.
  unknown: 48 * HOUR_MS,
});

interface Quote {
  price: Decimal;
  at: Date;
}

interface RankedQuote extends Quote {
  rank: number;
}

interface Route extends Quote {
  path: PricePath;
}

export function assetClassOf(typeCode: string | null | undefined): AssetClass {
  switch (typeCode) {
    case 'crypto':
    case 'fiat':
    case 'stock':
      return typeCode;
    case 'private-company':
    case 'other':
      return 'custom';
    default:
      return 'unknown';
  }
}

/**
 * Freshness decides: the route whose binding (older) reading is latest wins,
 * so a stored row in the user's base never beats a newer reading through a
 * hub (SC-1477). Staleness is reported, never applied.
 */
export function priceAt(
  evidence: PriceEvidence,
  asset: PriceAsset,
  baseTokenId: string,
  at: Date
): PriceAt | null {
  if (asset.tokenId === baseTokenId) {
    return { price: new Decimal(1), readingAt: at, path: 'identity', stale: false };
  }
  const readings = evidence.readings.filter((r) => r.at <= at);
  const route = freshest(routes(readings, asset.tokenId, baseTokenId, evidence.hubTokenIds));
  if (route === null) return null;
  const horizon = STALENESS_HORIZON_MS[asset.assetClass];
  return {
    price: route.price,
    readingAt: route.at,
    path: route.path,
    stale: horizon !== null && at.getTime() - route.at.getTime() > horizon,
  };
}

/** Every pair `priceAt` reads for these tokens, in both directions — the loader's list. */
export function readingPairsFor(
  tokenIds: Iterable<string>,
  baseTokenId: string,
  hubTokenIds: readonly string[]
): Array<{ tokenId: string; baseTokenId: string }> {
  const pairs = new Map<string, { tokenId: string; baseTokenId: string }>();
  for (const tokenId of tokenIds) {
    for (const [a, b] of routedPairs(tokenId, baseTokenId, hubTokenIds)) {
      pairs.set(JSON.stringify([a, b]), { tokenId: a, baseTokenId: b });
      pairs.set(JSON.stringify([b, a]), { tokenId: b, baseTokenId: a });
    }
  }
  return [...pairs.values()];
}

function routedPairs(
  asset: string,
  base: string,
  hubs: readonly string[]
): Array<[string, string]> {
  if (asset === base) return [];
  return [
    [asset, base],
    ...hopsBetween(asset, base, hubs).flatMap(
      (hub): Array<[string, string]> => [
        [asset, hub],
        [hub, base],
      ]
    ),
  ];
}

/** One hop at most, as today's default `maxDepth: 2`. */
function hopsBetween(asset: string, base: string, hubs: readonly string[]): string[] {
  return hubs.filter((hub) => hub !== asset && hub !== base);
}

/**
 * In priority order, so a tie in freshness goes to the earlier route whatever
 * the granularity of the readings behind it (D-9).
 */
function routes(
  readings: readonly PriceReading[],
  asset: string,
  base: string,
  hubs: readonly string[]
): Route[] {
  const candidates = [
    routed(best(readings, asset, base), 'direct'),
    routed(inverted(best(readings, base, asset)), 'inverse'),
    ...hopsBetween(asset, base, hubs).map((hub) => viaHub(readings, asset, base, hub)),
  ];
  return candidates.filter((c): c is Route => c !== null);
}

function viaHub(
  readings: readonly PriceReading[],
  asset: string,
  base: string,
  hub: string
): Route | null {
  const first = leg(readings, asset, hub);
  const second = leg(readings, hub, base);
  if (first === null || second === null) return null;
  return {
    price: first.price.times(second.price),
    at: first.at <= second.at ? first.at : second.at,
    path: `hub:${hub}`,
  };
}

/**
 * The later of the two directions. Granularity ranks readings within one
 * direction only, so a tie goes to the forward reading whatever either one's
 * granularity (D-9).
 */
function leg(readings: readonly PriceReading[], from: string, to: string): Quote | null {
  const forward = best(readings, from, to);
  const backward = inverted(best(readings, to, from));
  if (forward === null) return backward;
  if (backward === null || forward.at >= backward.at) return forward;
  return backward;
}

/**
 * The latest positive reading, finer granularity first at one instant. A full
 * tie, which the table's unique key rules out, goes to the higher price so the
 * answer never depends on the order readings arrive in.
 */
function best(readings: readonly PriceReading[], from: string, to: string): Quote | null {
  let top: RankedQuote | null = null;
  for (const r of readings) {
    if (r.tokenId !== from || r.baseTokenId !== to) continue;
    const quote = { price: new Decimal(r.price), at: r.at, rank: rankOf(r) };
    if (quote.price.gt(0) && (top === null || outranks(quote, top))) top = quote;
  }
  return top;
}

/** `token_prices.granularity` is text, so a value no type allows ranks below daily. */
function rankOf(reading: PriceReading): number {
  const index = PRICE_GRANULARITIES.indexOf(reading.granularity);
  return index === -1 ? 0 : PRICE_GRANULARITIES.length - index;
}

function outranks(a: RankedQuote, b: RankedQuote): boolean {
  return (a.at.getTime() - b.at.getTime() || a.rank - b.rank || a.price.comparedTo(b.price)) > 0;
}

function inverted(quote: Quote | null): Quote | null {
  return quote === null ? null : { price: new Decimal(1).div(quote.price), at: quote.at };
}

function routed(quote: Quote | null, path: PricePath): Route | null {
  return quote === null ? null : { price: quote.price, at: quote.at, path };
}

function freshest(candidates: readonly Route[]): Route | null {
  let top: Route | null = null;
  for (const candidate of candidates) {
    if (top === null || candidate.at > top.at) top = candidate;
  }
  return top;
}
