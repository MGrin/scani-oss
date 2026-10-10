import { Decimal } from '@scani/shared';
import { compareText } from './order';
import {
  bestReading,
  compareReadings,
  indexPriceEvidence,
  type PriceIndex,
  type Quote,
  type RankedQuote,
} from './price-index';
import type { AssetClass, PriceAsset, PriceAt, PriceEvidence, PricePath } from './types';

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

/** A pair's best reading at or before the instant asked. */
type Best = (from: string, to: string) => RankedQuote | null;

/** One leg of a route: `tokenId` priced by a reading taken at `at`. */
interface Leg {
  tokenId: string;
  at: Date;
}

/** Legs end to end: their product, as old as the oldest, with the first one's source. */
interface Way extends Quote {
  legs: readonly Leg[];
}

interface Route extends Way {
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
    case 'property':
    case 'vehicle':
      return 'custom';
    default:
      return 'unknown';
  }
}

/** A person typed it: the source is 'manual' or starts with it, as the legacy readers match (`manual%`). */
export function isManualSource(source: string | null): boolean {
  return source?.startsWith('manual') ?? false;
}

/**
 * Freshness decides: the route whose binding (older) reading is latest wins,
 * so a stored row in the user's base never beats a newer reading through a
 * hub (SC-1477). Staleness is reported, never applied, and each leg is judged
 * by the horizon of the token it prices: a manual price through a week-old
 * rate is stale, a crypto price through a weekend-old fiat rate is not.
 *
 * Plain evidence is indexed on every call: a caller with many asks of the
 * same evidence indexes it once and hands the index.
 */
export function priceAt(
  evidence: PriceEvidence | PriceIndex,
  asset: PriceAsset,
  baseTokenId: string,
  at: Date
): PriceAt | null {
  if (asset.tokenId === baseTokenId) {
    return { price: new Decimal(1), readingAt: at, path: 'identity', stale: false, source: null };
  }
  const index = 'readings' in evidence ? indexPriceEvidence(evidence) : evidence;
  const best: Best = (from, to) => bestReading(index, from, to, at);
  const hops = hopsBetween(asset.tokenId, baseTokenId, index.hubTokenIds);
  const quotes = quotesOf(
    asset.tokenId,
    baseTokenId,
    index.hubTokenIds,
    index.quoteTokenIds[asset.tokenId]
  );
  const route = freshest(routes(best, asset.tokenId, baseTokenId, hops, quotes));
  if (route === null) return null;
  const classOf = (tokenId: string): AssetClass =>
    tokenId === asset.tokenId ? asset.assetClass : (index.assetClasses[tokenId] ?? 'unknown');
  return {
    price: route.price,
    readingAt: route.at,
    path: route.path,
    stale: route.legs.some((leg) => pastHorizon(leg.at, classOf(leg.tokenId), at)),
    source: route.source,
  };
}

/**
 * Every pair `priceAt` reads for these tokens — the loader's list. Both
 * directions, except an asset's reading in a quote currency: its reverse
 * prices the currency in the asset and is never a first leg.
 */
export function readingPairsFor(
  tokenIds: Iterable<string>,
  baseTokenId: string,
  hubTokenIds: readonly string[],
  quoteTokenIds?: ReadonlyMap<string, readonly string[]>
): Array<{ tokenId: string; baseTokenId: string }> {
  const pairs = new Map<string, { tokenId: string; baseTokenId: string }>();
  const add = (from: string, to: string) =>
    pairs.set(JSON.stringify([from, to]), { tokenId: from, baseTokenId: to });
  for (const tokenId of tokenIds) {
    if (tokenId === baseTokenId) continue;
    const hops = hopsBetween(tokenId, baseTokenId, hubTokenIds);
    const quotes = quotesOf(tokenId, baseTokenId, hubTokenIds, quoteTokenIds?.get(tokenId));
    for (const quote of quotes) add(tokenId, quote);
    for (const from of [tokenId, ...quotes]) {
      for (const [a, b] of waysToBase(from, baseTokenId, hops)) {
        add(a, b);
        add(b, a);
      }
    }
  }
  return [...pairs.values()];
}

/** `from` to the base, directly and through each hop. */
function waysToBase(from: string, base: string, hops: readonly string[]): Array<[string, string]> {
  return [
    [from, base],
    ...hops.flatMap(
      (hub): Array<[string, string]> => [
        [from, hub],
        [hub, base],
      ]
    ),
  ];
}

/** One hop at most: a hub that is neither the asset nor the base. */
function hopsBetween(asset: string, base: string, hubs: readonly string[]): string[] {
  return hubs.filter((hub) => hub !== asset && hub !== base);
}

/**
 * The currencies the asset was handed as quoted in, less itself, the base and
 * the hubs, in plain string order. Handed per asset and never read off the
 * readings, so a reading outside the pair list cannot open a route (D-2).
 */
function quotesOf(
  asset: string,
  base: string,
  hubs: readonly string[],
  handed: readonly string[] = []
): string[] {
  const routedAlready = new Set([asset, base, ...hubs]);
  return [...new Set(handed)].filter((quote) => !routedAlready.has(quote)).sort(compareText);
}

/**
 * In priority order, so a tie in freshness goes to the earlier route whatever
 * the granularity of the readings behind it (D-9): direct, inverse, the hubs
 * as given, then the quote currencies by token id.
 */
function routes(
  best: Best,
  asset: string,
  base: string,
  hops: readonly string[],
  quotes: readonly string[]
): Route[] {
  const forward = forwardReadings(best, asset, [base, ...hops, ...quotes]);
  const toBase = (from: string) => way(from, leg(best, from, base));
  const candidates = [
    routed(way(asset, forward.get(base) ?? null), 'direct'),
    routed(way(asset, inverted(best(base, asset))), 'inverse'),
    ...hops.map((hub) => {
      const first = later(forward.get(hub) ?? null, inverted(best(hub, asset)));
      return routed(joined(way(asset, first), toBase(hub)), `hub:${hub}`);
    }),
    ...quotes.map((quote) => {
      const first = way(asset, forward.get(quote) ?? null);
      if (first === null) return null;
      const second = freshest(waysFromQuote(best, quote, base, hops));
      return second === null ? null : routed(joined(first, second), second.path);
    }),
  ];
  return candidates.filter(isRoute);
}

/**
 * The asset's best forward reading in each currency it is listed with. Of the
 * ones a person typed only the latest stands, whatever currency each was typed
 * in: otherwise an old price in the base beats a correction typed in another
 * currency until that currency's next rate (D-2). A superseded pair gives no
 * reading at all, never an older one from under it, so the answer is the same
 * from a pair's latest row as from its whole history.
 */
function forwardReadings(
  best: Best,
  asset: string,
  currencies: readonly string[]
): ReadonlyMap<string, RankedQuote> {
  const forward = new Map<string, RankedQuote>();
  for (const currency of currencies) {
    const reading = best(asset, currency);
    if (reading !== null) forward.set(currency, reading);
  }
  const typed = [...forward].filter(([, reading]) => isManualSource(reading.source));
  const latest = typed.reduce<Typed | null>(
    (top, entry) => (top === null || supersedes(entry, top) ? entry : top),
    null
  );
  for (const [currency] of typed) {
    if (currency !== latest?.[0]) forward.delete(currency);
  }
  return forward;
}

type Typed = readonly [currency: string, reading: RankedQuote];

/** Two prices typed at one instant leave one: the finer, then the higher, then the greater currency id. */
function supersedes([currency, reading]: Typed, [heldCurrency, held]: Typed): boolean {
  return (compareReadings(reading, held) || compareText(currency, heldCurrency)) > 0;
}

/** Straight to the base first, then through each hop, so equally fresh ways go in that order. */
function waysFromQuote(best: Best, quote: string, base: string, hops: readonly string[]): Route[] {
  const candidates = [
    routed(way(quote, leg(best, quote, base)), `quote:${quote}`),
    ...hops.map((hub) =>
      routed(
        joined(way(quote, leg(best, quote, hub)), way(hub, leg(best, hub, base))),
        `quote:${quote}:${hub}`
      )
    ),
  ];
  return candidates.filter(isRoute);
}

/** The later of the two directions of one pair. */
function leg(best: Best, from: string, to: string): Quote | null {
  return later(best(from, to), inverted(best(to, from)));
}

/**
 * Granularity ranks readings within one direction only, so a tie goes to the
 * forward reading whatever either one's granularity (D-9).
 */
function later(forward: Quote | null, backward: Quote | null): Quote | null {
  if (forward === null) return backward;
  if (backward === null || forward.at >= backward.at) return forward;
  return backward;
}

function inverted(quote: Quote | null): Quote | null {
  return quote === null ? null : { ...quote, price: new Decimal(1).div(quote.price) };
}

function way(tokenId: string, quote: Quote | null): Way | null {
  if (quote === null) return null;
  return {
    price: quote.price,
    at: quote.at,
    source: quote.source,
    legs: [{ tokenId, at: quote.at }],
  };
}

function joined(first: Way | null, second: Way | null): Way | null {
  if (first === null || second === null) return null;
  return {
    price: first.price.times(second.price),
    at: first.at <= second.at ? first.at : second.at,
    source: first.source,
    legs: [...first.legs, ...second.legs],
  };
}

function routed(found: Way | null, path: PricePath): Route | null {
  return found === null ? null : { ...found, path };
}

function isRoute(candidate: Route | null): candidate is Route {
  return candidate !== null;
}

function freshest(candidates: readonly Route[]): Route | null {
  let top: Route | null = null;
  for (const candidate of candidates) {
    if (top === null || candidate.at > top.at) top = candidate;
  }
  return top;
}

function pastHorizon(readAt: Date, assetClass: AssetClass, at: Date): boolean {
  const horizon = STALENESS_HORIZON_MS[assetClass];
  return horizon !== null && at.getTime() - readAt.getTime() > horizon;
}
