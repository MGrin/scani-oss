/**
 * The one place this provider decides what a sheet price is worth in
 * the user's base currency — and, just as importantly, when it will not
 * say.
 *
 * Four call sites used to make that decision inline, and they disagreed.
 * On the identical upstream failure the two existing-sheet-row paths
 * kept the *native* figure and the two new-token paths stored `'0'`, so
 * which wrong answer a user got was decided by whether the token already
 * had a row in the spreadsheet. For Toronto-listed CAD holdings the
 * first of those published a price ~37% high that looked entirely
 * ordinary (SC-847).
 *
 * A token whose currency is simply unknown reached neither branch: the
 * guard was `if (exchangeInfo?.currency && …)`, so an absent
 * `exchangeInfo` skipped conversion silently, with no failure anywhere
 * and no log line. That is the case extra guarding would not have
 * caught, because there is nothing to catch — and it is not
 * hypothetical: a token with no exchange info is given a bare
 * `=GOOGLEFINANCE("SYM")` formula, whose denomination we genuinely do
 * not know.
 */

import type { ConversionOutcome } from './conversion-outcome';

export type ConvertPriceFn = (
  price: string,
  fromCurrency: string,
  toCurrency: string,
  timestamp: Date
) => Promise<ConversionOutcome>;

/**
 * Express `rawPrice` in `baseCurrencySymbol`, or refuse.
 *
 * Refusing is a real answer. The caller turns it into a failure row,
 * which `PricingProviderRouter` declines to persist, so the last good
 * converted price stands rather than being overwritten by a wrong one.
 * Both previous answers — the native figure and `'0'` — were prices; a
 * value whose currency could not be established is not one.
 */
export async function priceInBaseCurrency(args: {
  rawPrice: string;
  currency: string | undefined;
  baseCurrencySymbol: string;
  timestamp: Date;
  convertPrice: ConvertPriceFn;
  symbol: string;
}): Promise<ConversionOutcome> {
  const { rawPrice, currency, baseCurrencySymbol, timestamp, convertPrice, symbol } = args;

  if (!currency) {
    return {
      ok: false,
      reason: `no exchange currency known for ${symbol}, so its price cannot be expressed in ${baseCurrencySymbol}`,
    };
  }

  return convertPrice(rawPrice, currency, baseCurrencySymbol, timestamp);
}
