# `tron/`

TRON balance + TRC-20 holdings + transactions via TronGrid.

- **Upstream**: `https://api.trongrid.io` (override via `TRON_API_URL`).
- **Capabilities**: `current-balances`, `transactions`, `address-validator`.
- **Auth**: optional `TRON-PRO-API-KEY` header (env `TRON_PRO_API_KEY`)
  for rate-limit relief.
- **Env**: none required.
- **Rate limit**: namespace `tron` — 1 req/s without a key (keyless
  TronGrid refuses the second request in a second and then suspends the
  caller), 10 req/s with `TRON_PRO_API_KEY`.
- **Endpoints used**:
  - `/v1/accounts/{address}` (activity probe; TRX balance, and the
    TRC-20 balances as `data[0].trc20` — raw amounts keyed by contract)
  - `/v1/trc20/info?contract_list=…` (symbol, name and decimals for those
    contracts, at most 20 per request)
  - `/v1/accounts/{address}/transactions` (native TRX history; native
    `owner_address` / `to_address` are HEX, so the wallet is converted
    to its 21-byte hex form once for in/out comparison)
  - `/v1/accounts/{address}/transactions/trc20` (TRC-20 transfer
    history; `from` / `to` are base58, compared as-is)
- **Pagination**: both transaction endpoints use `meta.fingerprint`
  as the cursor; limit capped at 200.
- **Errors**: any non-2xx is a `ProviderError` (`ProviderError.fromHttp`),
  so a refused balance read fails the chain rather than reading as an
  empty wallet. A refused transaction page retracts the history claim.
- **Notes**: address-validator covers base58check (`T...`, 34 chars).
  `address.ts` ships a base58 decoder + `tronBase58ToHex` helper used
  internally — no external bs58 dependency.
