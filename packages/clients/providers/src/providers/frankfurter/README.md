# `frankfurter/`

Frankfurter forex rates (ECB-sourced).

- **Upstream**: `https://api.frankfurter.dev/v1`.
- **Capabilities**: `current-price`, `historical-price`.
- **Env**: none (free, no key required).
- **Rate limit**: namespace `frankfurter` (10 req/s default).
- **Notes**: fiat currency pairs only — daily rates published by the
  ECB. Every request is made from EUR, the base the ECB publishes
  (`from=EUR&to=X,B`, without whichever side is EUR), and the pair is
  divided here: asked from another base, Frankfurter serves a table it
  derived and rounded itself (SC-1565). So EUR into another currency is
  the fixing as sent, a currency into EUR is one fixing inverted, and a
  pair with no EUR side is derived from two. An answer in another base is
  refused. A live rate for fiat the ECB does not publish
  (RUB, KZT, AED, …), or for an ECB pair Frankfurter did not answer,
  comes from `../exchangerate-api/`, under that client's own limiter. The live
  fallback covers the full published USD table, including smaller currencies
  such as ETB and SOS; a missing table entry gives no price.
