/**
 * Symbol mapping helpers for Yahoo Finance.
 *
 * Yahoo accepts most listings via `<TICKER>.<SUFFIX>` where the suffix
 * matches Finnhub-style listing codes — most of the time. Two fix-ups
 * we apply:
 *
 *  - Cboe Canada (formerly NEO Aequitas): tokens stored as `XEQT.NE`
 *    in our DB but Yahoo lists them as `XEQT.NEO`.
 *  - US listings: Yahoo accepts the bare ticker (`AAPL`, not `AAPL.US`).
 *
 * For currencies, Yahoo uses `<FROM><TO>=X` (e.g. `RUBUSD=X` for "USD
 * per RUB"). The bare `<CCY>=X` shorthand is `USD<CCY>=X` (USD-quoted),
 * which is the *opposite* direction of what we want, so we always use
 * the explicit two-currency form.
 */

import { detectExchangeInfo } from '../finnhub/symbol';

export interface YahooStockResolution {
  yahooSymbol: string;
  /** Native quote currency for the listing (CAD for .TO, GBP for .L, …).
   *  Defaults to USD for symbols without a recognized non-US suffix. */
  currency: string;
}

export function resolveYahooStockSymbol(rawSymbol: string): YahooStockResolution | null {
  if (!rawSymbol) return null;
  const upper = rawSymbol.toUpperCase().trim();
  if (!upper) return null;

  // Detect the listing currency from the *original* suffix because the
  // shared `detectExchangeInfo` map keys on internal forms (`.NE`,
  // `.TO`, `.L`, …). The Yahoo-side symbol mapping happens after.
  const exchangeInfo = detectExchangeInfo(upper);

  // Map our `.NE` to Yahoo's `.NEO` (Cboe Canada / NEO Aequitas).
  let yahooSymbol = upper.endsWith('.NE') ? `${upper.slice(0, -3)}.NEO` : upper;
  // Strip our internal `.US` marker if anyone ever stored one — Yahoo
  // doesn't carry it for NYSE/NASDAQ listings.
  yahooSymbol = yahooSymbol.replace(/\.US$/, '');

  return {
    yahooSymbol,
    currency: exchangeInfo?.currency ?? 'USD',
  };
}

/**
 * Yahoo's currency-pair symbol for "X per Y" rate. Returned in the format
 * Yahoo's chart endpoint expects.
 */
export function yahooFxPairSymbol(from: string, to: string): string {
  return `${from.toUpperCase()}${to.toUpperCase()}=X`;
}
