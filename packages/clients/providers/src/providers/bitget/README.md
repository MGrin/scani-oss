# `bitget/`

Bitget spot accounts, classic (V2) and unified trading accounts (V3 UTA).

- **Upstream**: `https://api.bitget.com`.
- **Capabilities**: `current-balances`, `transactions`, `credential-validator`.
- **Auth**: Base64(HMAC-SHA256(`timestamp + method + requestPath + ?query + body`,
  apiSecret)). Headers: `ACCESS-KEY`, `ACCESS-SIGN`, `ACCESS-TIMESTAMP`,
  `ACCESS-PASSPHRASE`. The same signing serves V2 and V3.
- **Env**: per-user `apiKey` + `apiSecret` + `passphrase`.
- **Rate limit**: 10 req/s; namespace `bitget-private`.
- **Account type**: each call first asks `/api/v3/account/settings`. A unified
  account answers it and is read through V3; a classic key is refused there and
  is read through V2. A unified key cannot call the V2 endpoints, and Bitget has
  migrated classic accounts to unified ones since 2026-09-15 (SC-1576).
- **Endpoints used**:
  - classic: `/api/v2/spot/account/assets`, `/api/v2/spot/trade/fills`,
    `/api/v2/spot/wallet/deposit-records`, `/api/v2/spot/wallet/withdrawal-records`
    (paged by `idLessThan`).
  - unified: `/api/v3/account/assets` plus `/api/v3/account/funding-assets`,
    `/api/v3/trade/fills?category=SPOT`, `/api/v3/account/deposit-records`,
    `/api/v3/account/withdrawal-records` (paged by `cursor`, windows of at most
    30 days).
- **Notes**: extends `BaseHmacCexProvider`. Classic balances sum
  `available + frozen + locked`; unified balances sum `balance` across the
  unified and funding accounts. The V3 shapes come from ccxt's `bitget.ts`
  samples; Bitget's own docs are not reachable from this machine.
