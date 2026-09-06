import type { PricingProviderKey } from './PricingProviderAdapter';

/**
 * Which external pricing authority, if any, a token type has.
 *
 * `null` means "no external provider — manual pricing only", and a code absent
 * from this table means the same thing for a stronger reason: nothing in the
 * system knows what that asset IS.
 *
 * ## Why this is its own module (SC-1115)
 *
 * The table lived in `PricingProviderRouter` and the historical backfill made a
 * SECOND, independent statement about the same question in
 * `filterProvidersByTokenType` — and the two disagreed. The router refused every
 * external provider for `private-company`; the filter returned all of them, so
 * the nightly backfill would offer CoinGecko a token whose whole point is that
 * its owner is the only pricing authority.
 *
 * That is not a display bug. `CoinGeckoProvider.canPrice` resolves an id from
 * the SYMBOL alone (`resolveCoingeckoId` -> `WELL_KNOWN_COINGECKO_IDS`, keyed by
 * lowercased symbol) with no reference to the token's type, so a custom token
 * sharing a symbol with a listed coin resolves and a real quote for a different
 * asset lands in `token_prices` — where `PricingService`'s manual fallback
 * cannot tell it from a legitimate one.
 *
 * One table, two readers, so the disagreement cannot be reintroduced by editing
 * one of them. `tests/services/pricing/token-type-pricing.test.ts` asserts the
 * two readers agree for every code in it.
 */
export const TOKEN_TYPE_TO_PROVIDER: Record<
  string,
  PricingProviderKey | 'stock-discriminator' | null
> = {
  fiat: 'exchangeRate',
  crypto: 'coinGecko',
  stock: 'stock-discriminator',
  'private-company': null,
  other: null,
};

/**
 * Whether any external provider may be asked to price this token type.
 *
 * **An unrecognised or absent type code answers `false`**, matching what the
 * router already does with one (`entry === undefined` -> warn -> `return null`).
 * The direction is chosen on the asymmetry of harm rather than on symmetry with
 * the known codes: refusing to price an asset we cannot classify costs an
 * ABSENT historical price, which renders as "—" and is recoverable by adding the
 * type here; asking anyway costs a same-symbol price for a different asset
 * WRITTEN into `token_prices`, which is indistinguishable from a real quote
 * afterwards. That asymmetry is the whole reason
 * `EQUITY_ONLY_PROVIDER_KEYS` / `CRYPTO_ONLY_PROVIDER_KEYS` exist.
 *
 * The accepted cost, stated so nobody has to rediscover it: `token_types` is
 * admin-extensible without a migration, so a type added to the database and not
 * to this table gets no historical backfill and nothing announces it. It also
 * gets no current pricing today, for the same reason and by the same table — so
 * this makes the backfill agree with pricing rather than introducing a new
 * silence.
 */
export function hasExternalPricingAuthority(typeCode: string | null | undefined): boolean {
  if (!typeCode) return false;
  const entry = TOKEN_TYPE_TO_PROVIDER[typeCode.toLowerCase()];
  return entry !== undefined && entry !== null;
}
