# `solana/`

Solana balances + SPL token holdings + transactions.

- **Upstream**: `https://api.mainnet-beta.solana.com` (public RPC) or
  `https://mainnet.helius-rpc.com/?api-key=...` (when `HELIUS_API_KEY`
  is set, much higher rate limits and transaction history).
- **Capabilities**: `current-balances`, `transactions`, `address-validator`.
- **Auth**: none (public RPC) or Helius API key.
- **Env**: `HELIUS_API_KEY` (optional — strongly recommended for any
  production scale; without it there is no transaction history).
- **Rate limit**: namespace `solana`.
- **Notes**: address-validator uses ed25519 base58 + length checks.
  SPL token holdings via `getTokenAccountsByOwner`. Transactions via
  Helius's `getTransactionsForAddress` (full transactions, every
  version, the wallet's token accounts included), paginated by
  `paginationToken`; each transaction is netted to one movement per
  token from its balances before and after (SC-1578, replacing the
  enhanced `/v0/addresses/{a}/transactions` endpoint Helius put in
  maintenance mode). A token balance from before the RPC recorded an
  `owner` counts as the wallet's when its account is the wallet's
  associated token account for that mint (`associated-token-account.ts`).
