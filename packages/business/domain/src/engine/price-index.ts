import { Decimal } from '@scani/shared';
import { compareText } from './order';
import {
  type AssetClass,
  PRICE_GRANULARITIES,
  type PriceEvidence,
  type PriceReading,
} from './types';

/** A reading as a route uses it: in the direction it was read, or inverted. */
export interface Quote {
  price: Decimal;
  at: Date;
  source: string | null;
}

/**
 * A pair's reading as an index keeps it. Its instant is a number taken when
 * the index is built: a Date the caller or an answer holds can be changed
 * later, and would reorder the pair under every later search.
 */
export interface RankedReading {
  price: Decimal;
  epoch: number;
  rank: number;
  source: string | null;
}

/** A pair's best reading at an instant, with a Date of its own. */
export interface RankedQuote extends Quote, RankedReading {}

/**
 * A lookup by token id, as a frozen object with no prototype: `Object.freeze`
 * leaves a Map open to `set`, and an ordinary object answers for ids nobody
 * handed, such as `constructor`.
 */
type Table<V> = Readonly<Record<string, V>>;

/**
 * Evidence laid out so a pair's best reading at an instant is one binary
 * search. Opaque beyond `hubTokenIds`: `priceAt` is its reader. Frozen
 * throughout and sharing no list or Date with the evidence or any answer, so
 * one index serves any number of asks.
 */
export interface PriceIndex {
  readonly hubTokenIds: readonly string[];
  readonly quoteTokenIds: Table<readonly string[]>;
  readonly assetClasses: Table<AssetClass>;
  /**
   * By token, then by base: the pair's readings, in the order that puts the
   * best one at any instant last among those at or before it.
   */
  readonly pairs: Table<Table<readonly RankedReading[]>>;
}

/**
 * Never throws on evidence. What is not a reading is left out: a price text
 * that is not a positive finite number, as `token_prices.price` is text with
 * no check, and an instant that is not one. An older reading of the same pair
 * still answers.
 */
export function indexPriceEvidence(evidence: PriceEvidence): PriceIndex {
  return Object.freeze({
    hubTokenIds: Object.freeze([...evidence.hubTokenIds]),
    quoteTokenIds: tableOf(evidence.quoteTokenIds ?? [], (quotes) => Object.freeze([...quotes])),
    assetClasses: tableOf(evidence.assetClasses ?? [], (assetClass) => assetClass),
    pairs: tableOf(readingsByPair(evidence.readings), (byBase) =>
      tableOf(byBase, (readings) => Object.freeze(readings.sort(compareRanked)))
    ),
  });
}

/** The pair's best reading at or before `at`: the last one there, in the pair's order. */
export function bestReading(
  index: PriceIndex,
  from: string,
  to: string,
  at: Date
): RankedQuote | null {
  const readings = index.pairs[from]?.[to];
  if (readings === undefined) return null;
  const limit = at.getTime();
  let low = 0;
  let high = readings.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((readings[middle] as RankedReading).epoch <= limit) low = middle + 1;
    else high = middle;
  }
  const found = readings[low - 1];
  return found === undefined ? null : { ...found, at: new Date(found.epoch) };
}

/** Time, then granularity, then price. */
export function compareReadings(a: RankedReading, b: RankedReading): number {
  return a.epoch - b.epoch || a.rank - b.rank || a.price.comparedTo(b.price);
}

function tableOf<T, V>(entries: Iterable<readonly [string, T]>, kept: (value: T) => V): Table<V> {
  const table: Record<string, V> = Object.create(null);
  for (const [key, value] of entries) table[key] = kept(value);
  return Object.freeze(table);
}

function readingsByPair(
  readings: readonly PriceReading[]
): Map<string, Map<string, RankedReading[]>> {
  const byToken = new Map<string, Map<string, RankedReading[]>>();
  for (const reading of readings) {
    const epoch = reading.at.getTime();
    // At or before no instant, and in no order with the rest: left in, it would
    // hide them from the search.
    if (Number.isNaN(epoch)) continue;
    const price = positivePrice(reading.price);
    if (price === null) continue;
    const byBase = byToken.get(reading.tokenId) ?? new Map<string, RankedReading[]>();
    byToken.set(reading.tokenId, byBase);
    const pair = byBase.get(reading.baseTokenId) ?? [];
    byBase.set(reading.baseTokenId, pair);
    pair.push(Object.freeze({ price, epoch, rank: rankOf(reading), source: reading.source }));
  }
  return byToken;
}

/**
 * The text form `token_prices.price` accepts: plain decimal notation, at most
 * 64 digits either side of the point, with an optional exponent of at most
 * three digits. Each bound keeps the column's cast from overflowing. Its CHECK
 * carries this pattern verbatim, and the writer sends only a text that matches
 * it and that `positivePrice` reads. That second test is what the CHECK's
 * `> 0` is.
 */
export const CANONICAL_PRICE_TEXT = /^[0-9]{1,64}(\.[0-9]{1,64})?([eE][-+]?[0-9]{1,3})?$/;

/**
 * The price a text reads as, or null when it is not a positive finite number.
 * Wider than the column: decimal.js also reads '+1', '0x1A' and '1_000'.
 */
export function positivePrice(text: string): Decimal | null {
  let price: Decimal;
  try {
    price = new Decimal(text);
  } catch {
    return null;
  }
  return price.isFinite() && price.gt(0) ? price : null;
}

/** `token_prices.granularity` is text, so a value no type allows ranks below daily. */
function rankOf(reading: PriceReading): number {
  const index = PRICE_GRANULARITIES.indexOf(reading.granularity);
  return index === -1 ? 0 : PRICE_GRANULARITIES.length - index;
}

/**
 * A pair's order: the later reading above the earlier, and at one instant the
 * finer granularity above the coarser. A full tie, which the table's unique
 * key rules out, goes to the higher price and then to the greater source, so
 * the answer never depends on the order readings arrive in.
 */
function compareRanked(a: RankedReading, b: RankedReading): number {
  return compareReadings(a, b) || compareSources(a.source, b.source);
}

function compareSources(a: string | null, b: string | null): number {
  if (a === null || b === null) return Number(b === null) - Number(a === null);
  return compareText(a, b);
}
