# `solana/`

Solana balances + SPL token holdings + transactions.

- **Upstream**: `https://api.mainnet-beta.solana.com` (public RPC) or
  `https://mainnet.helius-rpc.com/?api-key=...` (when
  `HELIUS_API_KEY` is set, much higher rate limits + getSignaturesForAddress
  pagination).
- **Capabilities**: `current-balances`, `transactions`, `address-validator`.
- **Auth**: none (public RPC) or Helius API key.
- **Env**: `HELIUS_API_KEY` (optional — strongly recommended for any
  production scale).
- **Rate limit**: namespace `solana`.
- **Notes**: address-validator uses ed25519 base58 + length checks.
  Transactions paginated via `getSignaturesForAddress`; SPL token
  holdings via `getTokenAccountsByOwner`.
