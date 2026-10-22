# `bitcoin/`

Bitcoin balance + transaction history via the public `blockchain.info` API.

- **Upstream**: `https://blockchain.info`; `https://mempool.space` for the
  balance during a blockchain.info penalty (SC-1716).
- **Capabilities**: `current-balances`, `transactions`,
  `address-validator`.
- **Auth**: none (public).
- **Env**: none.
- **Rate limit**: namespace `bitcoin` (1 req/s). A 429 from blockchain.info
  is a long penalty on the server's IP, so the provider asks it nothing for
  an hour after one, and each request there is tried once.
- **Endpoints used**: `/rawaddr/{addr}` (balance + activity probe +
  paginated tx history via `?limit=50&offset=N`); mempool.space
  `/api/address/{addr}` (confirmed plus pending balance).
- **Notes**: address-validator covers P2PKH (1...), P2SH (3...), and
  bech32 (bc1...) formats. Tx-history derives a signed net delta per
  tx by summing `out[].value where addr === wallet` minus
  `inputs[].prev_out.value where addr === wallet`, dividing by 1e8 for
  BTC. Sign drives the `transfer_in` / `transfer_out` kind.
