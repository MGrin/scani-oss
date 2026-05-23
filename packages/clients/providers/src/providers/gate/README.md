# `gate/`

Gate.io spot accounts.

- **Upstream**: `https://api.gateio.ws/api/v4`.
- **Capabilities**: `current-balances`, `transactions`, `credential-validator`.
- **Auth**: HMAC-SHA512 over `method\nurl\nqueryString\nsha512(body)\ntimestamp`.
  Headers: `KEY`, `SIGN`, `Timestamp`.
- **Env**: per-user `apiKey` + `apiSecret`.
- **Rate limit**: 10 req/s; namespace `gate-private`.
- **Endpoints used**: `/spot/accounts`, `/spot/accounts/ledger`,
  `/spot/my_trades`, `/wallet/deposits`, `/wallet/withdrawals`.
- **Notes**: extends `BaseHmacCexProvider`. `available + locked` summed
  for the user-facing total. Transactions strategy: ledger-per-currency
  is the primary "single feed" (covers fee + sub-account transfers);
  trade events come from `/spot/my_trades` per held base × quote pair
  (the per-leg ledger view lacks pair info); deposits/withdrawals come
  from `/wallet/deposits` + `/wallet/withdrawals` (txid-bearing source
  of truth). Pair format is delimited (`BTC_USDT`) so splitting is a
  trivial `split('_')`.
- **Live tests** (`SCANI_LIVE=1`): Gate.io spot has no public sandbox.
  Live tests hit production with read-only API keys via
  `SCANI_GATE_API_KEY` / `SCANI_GATE_API_SECRET`. Use a throwaway
  account with a small balance — production credentials see real
  funds.
