# `etherscan/`

Etherscan V2 multichain explorer — single endpoint with a `chainid`
param replaces the per-chain hosts (etherscan.io, polygonscan.com,
basescan.org, etc.). Primary balance + transaction provider for every
EVM L1 + L2 we support.

## Upstream

- Base: `https://api.etherscan.io/v2/api?chainid=<id>&...`
- API ref: <https://docs.etherscan.io/v/etherscan-v2/>.
- Per-chain config: `chains.ts` (chain id → institution code → native
  symbol/decimals).

## Capabilities

| Capability           | Endpoint                                   | Notes                                  |
| -------------------- | ------------------------------------------ | -------------------------------------- |
| `current-balances`   | `module=account&action=balance` + `tokenbalance` | Native + ERC-20 in one fetch flow. |
| `transactions`       | `txlist` + `tokentx` (via `BaseEvmProvider`) | Block-range pagination.            |
| `address-validator`  | `module=account&action=txlist` (probe)     | One-row check for activity.            |

Per-chain dispatch via `BaseEvmProvider.getChainConfig(institutionCode)`.

## Auth + env

- `ETHERSCAN_API_KEY` (required, shared across all chains in V2).
- Auth: query param `apikey=<key>`.
- No per-user creds — pool-credentialed (the wallet address is the
  per-user "credential" for chain providers).

## Rate limit + namespace

- Free tier: 5 req/s, 100k req/day.
- Pro tier: up to 30 req/s.
- Rate-limiter namespace: `etherscan` (shared across all chains —
  one V2 key bucket).

## Error taxonomy

The `BaseEvmProvider` doesn't HMAC-sign so it doesn't use the
`ProviderError.fromHttp` machinery. Errors come back as one of:

- `status === '0'` with `message === 'NOTOK'` → typically rate-limited
  or invalid params; treated as empty page (returns `[]`).
- `status === '0'` with `message === 'No transactions found'` →
  legitimate empty result (returns `[]`).
- HTTP 4xx/5xx → `Error` thrown; `fetchWithTimeout` retries 5xx.
- Network timeout → `Error`; same retry loop.

## Known quirks + gotchas

- **`page * offset` ≤ 10,000**. The base paginates by
  `(startblock, endblock)` rather than page index — see
  `BaseEvmProvider.fetchTransactionsByBlockRange`. New L2s without
  this restriction would still work but waste calls; not worth
  detecting.
- **Failed txs** (`isError === '1'` or `txreceipt_status === '0'`)
  are skipped. They burn gas but move no value, so the ledger
  ignores them. If we ever surface "gas spent on failed tx" as a
  separate `fee` event, that's a follow-up.
- **ERC-20 spam tokens** (airdrop dust, fake USDC variants) flood
  `tokentx` for any active wallet. `spam-filter.ts` drops contracts
  whose names match airdrop patterns (`*.fi`, `*.io`, "claim",
  "reward at"); the threshold is heuristic and tuned for the worst
  offenders rather than perfect precision.
- **ENS lookups** live in `ens.ts` and only run on Ethereum mainnet
  (`chainId === 1`). Reverse resolution (`name` from address) uses
  the canonical resolver contract; forward resolution isn't
  implemented (we don't accept ENS names for input today).
- **V2 vs V1 hosts**: the V1 hosts (`api.etherscan.io`,
  `api.polygonscan.com`, …) still work but require per-chain keys.
  V2 unifies everything under one key. Don't add new chains by
  pointing at a V1 host — register them via `chains.ts` instead.

## Source of truth

Concrete code: `index.ts`. Chain catalog: `chains.ts`. ENS resolver:
`ens.ts`. Spam filter: `spam-filter.ts`.
