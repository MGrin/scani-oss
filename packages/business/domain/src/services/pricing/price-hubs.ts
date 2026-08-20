/**
 * The routing hubs `PriceGraphService` walks when a pair has no direct
 * edge, and the only definition of them. Three copies of this list used
 * to exist — the service's own default, `CurrencyConverter`'s
 * `FIAT_HUB_SYMBOLS`, and `RollupPortfolioValueDailyUseCase`'s
 * `PRICE_HUB_SYMBOLS`, the last carrying a "keep in sync" comment and
 * nothing that checked.
 *
 * A hub is a `tokens` row, and a symbol cannot address one. `tokens` is
 * unique on `(symbol, type_id, COALESCE(market_segment,''))`, so eight
 * symbols in production have more than one legitimate row, and
 * `findBySymbol` tie-breaks `asc(isScamProbability), desc(createdAt)` —
 * a guess that reliably prefers the newest row (SC-223). For `USD` and
 * `EUR` that is a memecoin beating the currency; for `USDT` it is one
 * chain's ERC-20 beating the merged canonical row that actually carries
 * the price edges, which kills the whole USDT lane silently (SC-315).
 *
 * So a hub is pinned to its type here, and resolved on the identity
 * tuple with `marketSegment: null` — the unique constraint makes that
 * at most one row, with no tiebreak to lose. That row is the canonical
 * one by construction: migration 0007 collapsed chain-spread crypto
 * duplicates into a single row and forced its segment to NULL, and
 * `TokenIdentityService` never segments a fiat symbol.
 *
 * The type cannot simply be `fiat`: `USDT` is a crypto stablecoin used
 * deliberately as a hub so crypto-quoted tokens can reach a fiat base.
 */
export interface PriceHub {
  readonly symbol: string;
  readonly typeCode: 'fiat' | 'crypto';
}

/**
 * Evaluated in order; the first hub whose two legs both resolve wins.
 * USD first because every forex-backfill edge is anchored on it, which
 * is also why the two positions behind it are nearly unreachable for
 * fiat pairs. This is the order `PriceGraphService` and the nightly
 * rollup already used; `CurrencyConverter` listed EUR second, and now
 * shares this one.
 */
export const PRICE_HUBS: readonly PriceHub[] = [
  { symbol: 'USD', typeCode: 'fiat' },
  { symbol: 'USDT', typeCode: 'crypto' },
  { symbol: 'EUR', typeCode: 'fiat' },
];

export function priceHubKey(hub: PriceHub): string {
  return `${hub.typeCode}:${hub.symbol}`;
}
