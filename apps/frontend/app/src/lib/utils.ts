import { getFormatLocale, type Token } from '@scani/shared';
import type { TFunction } from 'i18next';

export { cn } from '@scani/ui/lib/cn';

/**
 * A display-only `Token` for a fiat currency, for before the real one loads.
 *
 * The name comes from `Intl.DisplayNames` rather than a table (SC-411). There
 * was a hand-written English name per currency here — twenty of them, from
 * `US Dollar` to `South African Rand` — and every one was byte-identical to
 * what CLDR already answers for `en-US`, measured across all twenty. So the
 * table was not a set of product decisions that happened to look like CLDR; it
 * was CLDR, transcribed, in one language, needing eight translations per row
 * the moment a second language shipped.
 *
 * `Intl.DisplayNames` returns the CODE for a currency it does not know, which
 * is a worse `name` than a `symbol` beside it already is, so an unknown code
 * gets a keyed sentence instead.
 *
 * **This name is the PLACEHOLDER's, and usually not the one on screen.** Once
 * `users.getBaseCurrency` resolves, `BaseCurrencyProvider` carries
 * `tokens.name` from Postgres through instead — an English string in a
 * database column, which no key can reach. See SC-419.
 */
export function createCurrencyToken(t: TFunction, currencySymbol: string): Token {
  return {
    id: `currency-${currencySymbol}`,
    symbol: currencySymbol,
    name: currencyDisplayName(t, currencySymbol),
    iconUrl: null,
    isActive: true,
    typeId: '',
    providerMetadata: '',
  };
}

/**
 * `getFormatLocale().language`, not `numberLocale` — this is a WORD, and the
 * region only decides how figures are punctuated. A reader on English copy
 * with German dates still wants "Swiss Franc".
 */
function currencyDisplayName(t: TFunction, code: string): string {
  const named = new Intl.DisplayNames([getFormatLocale().language], { type: 'currency' }).of(code);
  return named === undefined || named === code
    ? t('currency.unknownName', { symbol: code })
    : named;
}
