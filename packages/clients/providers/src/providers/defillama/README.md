# `defillama/`

DefiLlama Coins API. Primary fallback when CoinGecko doesn't have a
token (newer L2 tokens, fresh DEX listings) and primary historical-price
provider for backfill — no date cap, free, no key.

## Upstream

- Base: `https://coins.llama.fi`
- API ref: <https://defillama.com/docs/api> (Coins API section).

## Capabilities

| Capability         | Endpoint                                              | Notes                              |
| ------------------ | ----------------------------------------------------- | ---------------------------------- |
| `current-price`    | `/prices/current/{chain}:{address}`                   | One token per call (no batch).     |
| `historical-price` | `/prices/historical/{unix}/{chain}:{address}`         | Unbounded date range; primary backfill. |
| `token-identity`   | (synthesizes coin keys from etherscan/coingecko meta) | Pure derivation, no upstream call. |

`canPrice(t)` returns true when we can derive a coin key from the
token's metadata. Two paths:
- `etherscan` namespace → `"<chainName>:<contractAddress>"` for EVM
  tokens (chain catalog in `chains.ts`).
- `coingecko` namespace → `"coingecko:<id>"` as a final fallback.

## Auth + env

- None. Free public API, no key.
- Pool-credentialed (no per-user creds).

## Rate limit + namespace

- Default: 10 req/s.
- Rate-limiter namespace: `defillama`.

## Error taxonomy

- 4xx (token unknown, malformed key) → returns `null` (not an error;
  caller falls through to the next pricer in the chain).
- 5xx → bubbles up as `Error` after `fetchWithTimeout` retries (4
  attempts). PricingService catches and emits `*_failure:` source.
- Confidence < `DEFILLAMA_MIN_CONFIDENCE` (0.8) → treated as null.
  DeFiLlama returns a per-row confidence score; sub-0.8 quotes are
  typically fresh scam contracts, so we drop them rather than feed
  garbage prices into the cost-basis ledger.

## Known quirks + gotchas

- **No batch endpoint**. `fetchCurrentPrices` issues one call per token.
  For bulk pricing, prefer CoinGecko's `/simple/price`.
- **EVM chain naming**: DeFiLlama uses chain name slugs
  (`ethereum`, `polygon`, `arbitrum`, `bsc`, `optimism`, …), not
  numeric chain ids. The `CHAIN_ID_TO_DEFILLAMA` map in `chains.ts`
  is the source of truth — keep it in sync with new EVM L2s.
- **Stale current-price**: `/prices/current` may return a quote with
  a `timestamp` minutes old when the token has thin liquidity.
  We pass the upstream `timestamp` through verbatim so the orchestrator
  can decide if it's still fresh enough.
- **Historical bars are end-of-period**, not session opens. Use the
  unix second exactly at the day boundary for daily-close semantics.
- **No FX support**. `vs_currency` is implicitly USD; non-USD bases
  go through the injected `CurrencyConverter` (same as CoinGecko's
  exotic-base path).

## Source of truth

Concrete code: `index.ts`. Chain map: `chains.ts`.
