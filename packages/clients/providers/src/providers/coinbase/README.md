# `coinbase/`

Coinbase App API (v2).

- **Upstream**: `https://api.coinbase.com`.
- **Capabilities**: `current-balances`, `transactions`, `credential-validator`.
- **Auth**: a Coinbase Developer Platform (CDP) API key with the ECDSA
  signature algorithm. Every request carries `Authorization: Bearer <jwt>`,
  an ES256 JWT signed with the key's EC private key: header `kid` = key name
  and a random hex `nonce`; claims `sub` = key name, `iss: "cdp"`, `nbf`,
  `exp = nbf + 120`, `uri = "<METHOD> api.coinbase.com<path>"` (no query
  string). Plus `CB-VERSION: 2024-01-01`. Ed25519 CDP keys and the retired
  legacy HMAC keys (`CB-ACCESS-*` headers) are not supported. See
  <https://docs.cdp.coinbase.com/coinbase-app/authentication-authorization/api-key-authentication>.
- **Env**: per-user `apiKey` (the key `name`, `organizations/…/apiKeys/…`) +
  `apiSecret` (the `privateKey` PEM; JSON-escaped `\n` and surrounding quotes
  are accepted as pasted).
- **Rate limit**: 5 req/s; namespace `coinbase-private`.
- **Endpoints used**: `/v2/accounts?limit=100` and
  `/v2/accounts/{id}/transactions?limit=100`, both paginated via
  `pagination.next_uri`.
- **Notes**: extends `BaseHmacCexProvider`, whose `signRequest` hook returns
  the bearer header here. One account per currency in Coinbase's model;
  multiple wallets of the same currency are summed. Account list capped at 50
  pages, each account's transactions at 200.
