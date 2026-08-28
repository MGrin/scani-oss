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
    decimals: 2,
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
/**
 * A token's name as a reader should see it.
 *
 * **Fiat is DERIVED from the symbol; everything else keeps its stored name,
 * and that asymmetry is the decision rather than an omission (SC-419).**
 *
 * `tokens.name` is English prose in Postgres that no locale file can reach.
 * For fiat that is pure loss: all 136 seeded fiat rows are ISO-4217, and every
 * one of them resolves through CLDR in all six shipped locales — measured, 136
 * of 136 in each — so a stored English string is strictly worse than a
 * derivation costing no keys at all.
 *
 * For everything else translation is the WRONG answer, not a missing one:
 *
 * - A crypto or equity name is a proper noun. "Bitcoin", "Ethereum",
 *   "APPLE INC" are the same word in every language, and a good many of these
 *   rows have `name === symbol` because the provider gave us nothing better.
 * - A custom token's name is a word its own user typed
 *   (`tokens.createCustom`, `z.string().min(1).max(200)`). Rendering a
 *   translation of it would show somebody something they did not write.
 * - The rest arrive verbatim from Finnhub / CoinGecko / DefiLlama
 *   (`TokenService.createManyFromExternal`), so there is no key to translate
 *   them under and no authority to invent one.
 *
 * `tokens.name` is also WRITE-ONCE — of the thirteen `update(tokens).set(…)`
 * sites in this repo, none sets `name` — so there is no correction path a
 * translation could have ridden on either.
 *
 * **So a non-fiat name showing in English is not a missing key.** It is this
 * decision, and it is not worth reopening.
 *
 * `typeCode` is the `token_types.code` — `fiat`, `crypto`, … — and it is named
 * that way on purpose. The holdings DTO carries BOTH `type` (the type's
 * human NAME) and `typeCode`, while `tokens.getAll` calls the CODE `type`; a
 * parameter that accepted either would silently take a name for a code at half
 * its call sites.
 */
export function tokenDisplayName(
  t: TFunction,
  token: { symbol: string; name: string; typeCode: string | null | undefined }
): string {
  return token.typeCode === 'fiat' ? currencyDisplayName(t, token.symbol) : token.name;
}

function currencyDisplayName(t: TFunction, code: string): string {
  const named = new Intl.DisplayNames([getFormatLocale().language], { type: 'currency' }).of(code);
  return named === undefined || named === code
    ? t('currency.unknownName', { symbol: code })
    : named;
}
