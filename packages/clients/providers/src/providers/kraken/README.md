# `kraken/`

Kraken spot accounts + ledger history + OHLC pricing. Reference
implementation for new CEX providers needing pagination + transactions
support.

## Upstream

- Base: `https://api.kraken.com`
- API ref: <https://docs.kraken.com/api/> (REST API).

## Capabilities

| Capability             | Endpoint                                | Notes                                |
| ---------------------- | --------------------------------------- | ------------------------------------ |
| `current-balances`     | `POST /0/private/Balance`               | Single call, all assets.             |
| `transactions`         | `POST /0/private/Ledgers` (paginated)   | Streamed via `BaseCexProvider`.      |
| `current-price`        | (returns null)                          | Defers to CoinGecko/DeFiLlama.       |
| `historical-price`     | `GET /0/public/OHLC?pair=…&interval=1440` | Daily bars; `kraken-ohlc.ts`.       |
| `token-identity`       | (asset normalizer, no upstream call)    | XXBT → BTC, XETH → ETH, etc.         |
| `credential-validator` | `POST /0/private/Balance` (200 = valid) | Same call as balances.               |

`canPrice(t)` for historical returns true ONLY when
`providerMetadata.kraken.asset` is set (CEX-native asset code like
`XXBT`). New tokens enter that namespace via the asset normalizer
when first observed in a Ledgers response.

## Auth + env

- Per-user `apiKey` + `apiSecret` (encrypted in
  `user_integration_credentials`).
- HMAC-SHA512 over `path + sha256(nonce + body)` → base64.
- Headers: `API-Key`, `API-Sign`.
- No env vars — public OHLC needs no auth.

## Rate limit + namespace

- Private endpoints: 1 req/s by default (Kraken's tier ladder
  scales counter decrement; conservative single-bucket here works).
- Public endpoints: 10 req/s.
- Rate-limiter namespaces: `kraken-private` (per-credential),
  `kraken-public` (shared).

## Error taxonomy

Kraken returns 200 with `result.error: string[]` on most failures.
The provider's wrapper translates:

- `EAPI:Invalid key` / `EAPI:Invalid signature` → bubbles as `Error`
  (the use case sees "kraken HTTP 200 — Invalid key" — we don't
  short-circuit because Kraken may pin the same code for
  permissions misconfigurations).
- `EAPI:Rate limit exceeded` → bubbles; the rate limiter eats most
  of these, but a burst can slip through.
- HTTP non-2xx → `Error` thrown.

`validateCredentials` short-circuits to `{ valid: false, message }`
on auth-shaped errors instead of throwing.

## Known quirks + gotchas

- **Asset codes are not symbols**. Kraken historical assets carry
  the X/Z prefix (`XXBT` = Bitcoin, `XETH` = Ethereum, `ZUSD` =
  USD). Newer assets dropped the prefix (`SOL`, `DOT`, `MATIC`).
  `asset-normalizer.ts` owns the translation; updating it as new
  assets list is the maintenance burden.
- **Ledger pagination is opaque**. `Ledgers` returns up to 50 rows
  per call and a `count` claiming total ledger entries; iterate
  via `ofs` (offset). The base's `BaseCexProvider` consumes the
  generator until it stops yielding.
- **Sign convention is wrong out of the box**. Kraken's `amount`
  field is positive for both buys and sells; the `BaseCexProvider`'s
  `enforceSign(kind)` corrects it. Fee is always positive in the
  raw payload; the base negates.
- **OHLC is daily by default** (`interval=1440`). Smaller intervals
  exist (1m / 5m / 15m / 30m / 1h / 4h / 1d / 7d / 15d) but daily
  is what historical-price backfill uses.
- **OHLC pair format**: matches the asset code, so
  BTC/USD = `XXBTZUSD`. Other pairs (`SOLUSD`, `MATICUSD`) follow
  the dropped-prefix convention. The OHLC fetcher uses
  `providerMetadata.kraken.asset + 'USD'` as the pair key.

## Source of truth

Concrete code: `index.ts`. Asset map: `asset-normalizer.ts`. OHLC
fetcher: `kraken-ohlc.ts`.
