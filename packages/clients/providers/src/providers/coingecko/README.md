# `coingecko/`

CoinGecko Public + Pro REST API. Primary current-price provider for
crypto, plus historical-close + identity enrichment for the federated
token-identity flow.

## Upstream

- Public: `https://api.coingecko.com/api/v3`
- Pro: `https://pro-api.coingecko.com/api/v3` (used when
  `COINGECKO_API_KEY` is set; auth header `x-cg-pro-api-key`).
- API ref: <https://docs.coingecko.com/reference/introduction>.

## Capabilities

| Capability         | Endpoint                                       | Notes                              |
| ------------------ | ---------------------------------------------- | ---------------------------------- |
| `current-price`    | `/simple/price?ids=…&vs_currencies=…`          | Batch up to ~250 ids per call.     |
| `historical-price` | `/coins/{id}/history?date=DD-MM-YYYY`          | Daily close at 00:00 UTC.          |
| `token-identity`   | `/coins/list` (cached at process scope)        | Symbol → id resolution fallback.   |

`canPrice(t)` returns true when either `providerMetadata.coingecko.id`
is set OR the symbol resolves through `well-known-ids.ts` (a curated
map of the ~50 most-traded symbols → CoinGecko ids).

## Auth + env

- `COINGECKO_API_KEY` (optional). Public key works without it; setting
  it switches the base URL + adds `x-cg-pro-api-key` and lifts the rate
  cap from ~25 req/min to whichever Pro tier the key is on.
- No per-user creds — pool-credentialed.

## Rate limit + namespace

- Free tier: ~25 req/min (CoinGecko's published cap; in practice
  ~30 burst then throttle).
- Pro tier: 500–10k req/min depending on plan.
- Rate-limiter namespace: `coingecko`.

## Error taxonomy

The provider doesn't extend `BaseHmacCexProvider`, so it owns its own
error mapping. `fetchWithTimeout` retries 429/5xx with backoff (4
attempts). After retries:

- 401/403 → bubbles up as `Error` (treat as misconfigured `COINGECKO_API_KEY`).
- 404 on `/coins/{id}/history` → returns `null` (no quote at that date).
- 429 / 5xx after retry budget → bubbles up; the caller (PricingService)
  catches and emits a `*_failure:` source on the per-token result.

## Known quirks + gotchas

- **`/coins/list` is paginated** but the provider fetches the full
  list on first cache miss. ~13k entries × ~150 bytes each = ~2MB
  cache; lives in process memory until restart.
- **Symbol collisions**: 100+ tokens share the symbol `BTC` (most are
  scams). `well-known-ids.ts` pins canonical ids for the top
  ~50 symbols so the identity fallback doesn't pick the wrong one.
  Outside of that list, callers must seed
  `providerMetadata.coingecko.id` explicitly.
- **Currency support**: CoinGecko natively supports ~50 fiat + crypto
  bases (USD/EUR/GBP/CHF/JPY/RUB/TRY/CAD/AUD/CNY/…). For exotic bases
  the provider falls back to USD then converts via the injected
  `CurrencyConverter` (domain-side `CurrencyConverter` in direct mode;
  cloud mode never reaches this path because data-provider performs the
  call).
- **`/coins/{id}/history` returns `market_data.current_price[base]` but
  only if the token had liquidity that day**. Tokens that didn't exist
  yet (or ones too obscure on that date) come back with `market_data`
  unset; we treat that as a null quote.

## Source of truth

Concrete code: `index.ts`. Symbol map: `well-known-ids.ts`.
