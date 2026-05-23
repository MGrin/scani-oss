# `binance/`

Binance spot + cross-margin balances + credential validation. Largest
CEX by volume; the reference implementation for `BaseHmacCexProvider`
subclasses.

## Upstream

- Base: `https://api.binance.com`
- API ref: <https://developers.binance.com/docs/binance-spot-api-docs>.

## Capabilities

| Capability             | Endpoint                              | Notes                                |
| ---------------------- | ------------------------------------- | ------------------------------------ |
| `current-balances`     | `GET /api/v3/account` (spot)          | Always present per key.              |
|                        | `GET /sapi/v1/margin/account`         | Margin account; opt-in per-key.      |
| `transactions`         | (stub today)                          | `myTrades` port is a follow-up.      |
| `credential-validator` | `GET /api/v3/account` → 2xx           | Reuses the spot path.                |

## Auth + env

- Per-user `apiKey` + `apiSecret` (encrypted in
  `user_integration_credentials`).
- HMAC-SHA256 over query string. Sig appended as `&signature=…`.
- Headers: `X-MBX-APIKEY`.
- No env vars — Scani never holds Binance keys.

## Rate limit + namespace

- Per IP: 6,000 req/min weighted (every endpoint costs 1–10 weight
  units; `account` costs 10).
- Per API key: 100k req/day on spot, 1.2M on margin.
- Rate-limiter namespace: `binance` per credential
  (via `credentialBucketKey`).

## Error taxonomy

`BaseHmacCexProvider.signedFetch` translates non-2xx via
`ProviderError.fromHttp`:

- 401/403 / Binance error code `-2014/-2015/-2008` → `kind: auth-failed`.
  Bubbles to `validateCredentials` as `{ valid: false, message }`.
- 418 (IP banned) → `kind: rate-limited`; treat as fatal for that IP.
- 429 → `kind: rate-limited`. The base limiter usually eats these, but
  a burst across multiple users with the same IP can slip through.
- 400 with code `-1003` (too many requests) → `kind: rate-limited`.
- 5xx → `kind: retryable`. `fetchWithTimeout` already retried 3 times.
- Margin account 4xx (account doesn't have margin enabled) → swallowed
  as "no margin account here", not a failure of the whole sync. See
  `index.ts` `fetchBalances`.

## Known quirks + gotchas

- **Margin opt-in**. Most users don't have a margin account; calling
  `/sapi/v1/margin/account` returns a 4xx for those. We tolerate it
  rather than failing the entire sync — the spot result still flows
  through.
- **Symbol normalization**. Binance asset codes are unmodified
  symbols (`BTC`, `USDT`, `BUSD`); no prefix games like Kraken.
  Token identity flows through unchanged.
- **`free` vs `locked`**. The provider sums both into one balance
  (Binance reserves the locked portion for open orders; we surface
  it as part of the holding because it's still the user's value).
- **Region-blocked**. Binance.US (`api.binance.us`) is a separate
  service with a different surface. Users in restricted jurisdictions
  who hold Binance.US accounts won't authenticate against the global
  endpoint — there's no Binance.US provider yet (follow-up).
- **`recvWindow`**. Default 5000ms. The signing helper sets it on
  every request; if a user's clock skew is severe (>30s), Binance
  rejects with `-1021`. We don't currently sync time on boot.
- **Transactions stub**. The current `BaseCexProvider`-style port
  for `/api/v3/myTrades` (per-symbol pagination) hasn't shipped.
  Users who only use Scani for balance tracking are unaffected.

## Source of truth

Concrete code: `index.ts`. HMAC base class:
`../../../core/base/base-hmac-cex-provider.ts`.
