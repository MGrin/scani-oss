import Decimal from 'decimal.js';
import type { PriceAsk, PriceAt } from '../../src/engine/types';
import type { PriceReader, PriceSeries } from '../../src/services/pricing/PriceReader';

/**
 * What one unit of `tokenId` is worth in `baseTokenId` at `at`, or null when
 * unpriced: the shape the cost-basis and flow tests stubbed the graph with.
 */
export type StubConvert = (
  amount: Decimal,
  tokenId: string,
  baseTokenId: string,
  at: Date
) => { amount: Decimal; stale: boolean } | null;

/**
 * A series answering from `convert`, and throwing on an instant it was not
 * asked for, as `PriceReader`'s does. So a test that values a row at an
 * instant `valuationInstantsOf` did not list fails here too.
 */
export function seriesFrom(
  asks: readonly PriceAsk[],
  baseTokenId: string,
  convert: StubConvert
): PriceSeries {
  const asked = new Set(asks.map((ask) => `${ask.tokenId}|${ask.at.getTime()}`));
  return {
    priceAt(tokenId: string, at: Date): PriceAt | null {
      if (!asked.has(`${tokenId}|${at.getTime()}`)) {
        throw new RangeError(`the price of token ${tokenId} at ${at.toISOString()} was not asked`);
      }
      const answer = convert(new Decimal(1), tokenId, baseTokenId, at);
      return answer
        ? {
            price: answer.amount,
            readingAt: at,
            path: 'direct',
            stale: answer.stale,
            source: 'stub',
          }
        : null;
    },
    fingerprint: 'stub',
  };
}

/** A `PriceReader` whose every series answers from `convert`. */
export function priceReaderStub(convert: StubConvert): PriceReader {
  return {
    series: async (asks: readonly PriceAsk[], baseTokenId: string) =>
      seriesFrom(asks, baseTokenId, convert),
    at: async (tokenIds: readonly string[], baseTokenId: string, at: Date) => {
      const series = seriesFrom(
        tokenIds.map((tokenId) => ({ tokenId, at })),
        baseTokenId,
        convert
      );
      return new Map(tokenIds.map((tokenId) => [tokenId, series.priceAt(tokenId, at)]));
    },
    firstReadingAt: async () => new Map(),
  } as unknown as PriceReader;
}

/** `reader` with no first reading for any token, so a drift opening books at its start. */
export function withoutFirstReadings(reader: PriceReader): PriceReader {
  return Object.assign(Object.create(reader), { firstReadingAt: async () => new Map() });
}

/** A `PriceReader` for tests whose rows must read no price. */
export const noPriceReader: PriceReader = priceReaderStub(() => {
  throw new Error('no price should be read in these tests');
});
