# `bybit/`

Bybit V5 balances (Funding + Unified), transactions and creds-validate.

- **Upstream**: `https://api.bybit.com`.
- **Capabilities**: `current-balances`, `transactions`, `credential-validator`.
- **Auth**: HMAC-SHA256 over `timestamp + apiKey + recvWindow + queryString`.
  Headers: `X-BAPI-API-KEY`, `X-BAPI-TIMESTAMP`, `X-BAPI-SIGN`,
  `X-BAPI-RECV-WINDOW`.
- **Env**: per-user `apiKey` + `apiSecret`.
- **Rate limit**: 10 req/s; namespace `bybit-private`.
- **Endpoints used**:
  - balances: `/v5/account/wallet-balance?accountType=UNIFIED` plus
    `/v5/asset/transfer/query-account-coins-balance?accountType=FUND`,
    summed per coin. Deposits land in Funding and withdrawals leave from it,
    so Unified alone misses both (SC-1461). Moves between the two wallets
    are never imported: they net to zero inside the summed balance.
  - transactions: `/v5/execution/list`, `/v5/asset/deposit/query-record`,
    `/v5/asset/deposit/query-internal-record` (from other Bybit users),
    `/v5/asset/withdraw/query-record?withdrawType=2` (on-chain and to other
    Bybit users; the default is on-chain only).
  - derivatives: `/v5/account/transaction-log?accountType=UNIFIED`. Futures
    fills, funding settlements, liquidations and delivery import as
    `realized_pnl` (signed, a return in Returns, never a contribution or
    withdrawal); borrow interest paid as `fee`; Bybit's auto-repay
    `CURRENCY_SELL`/`CURRENCY_BUY` pair as one `sell`. Spot fills and
    Funding/Unified transfers in the log are skipped, since the execution
    list and the summed balance already cover them. Rows are keyed on Bybit's
    id, because adjacent 7-day windows share a boundary instant (SC-1461).
    A row of any other log type that moves a balance is counted and named
    in the run's warnings and a `warn` log line, and never imported as a
    row (SC-1591).
- **Permissions**: the key needs the Assets/Wallet read permission. Without it
  the Funding read returns `retCode 10005`, and both sync and credential
  validation fail with a message naming the permission rather than reading
  Unified alone.
- **Notes**: extends `BaseHmacCexProvider`. `walletBalance` is the
  spot+derivatives total in coin units (UTA mode).
