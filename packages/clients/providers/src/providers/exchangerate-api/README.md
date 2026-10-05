# `exchangerate-api/`

The one client of exchangerate-api.com's open-access rates. It is not a
registered provider: it has no capabilities and no boot factory. Three
callers read its USD table and derive their pair from it:

- `../frankfurter/` — the live-rate fallback for fiat the ECB does not
  publish (RUB, KZT, AED, …), and for an ECB pair Frankfurter did not
  answer;
- `@scani/providers-google-sheets` — converting a sheet price from the
  token's native currency to the base currency;
- `@scani/domain`'s `CurrencyConverter` — a conversion with no stored rate
  under 24 hours old, and the api's boot warm-up.

- **Upstream**: `https://api.exchangerate-api.com/v4/latest/USD`. No other
  base is ever requested: asked by its own base, a low-value currency
  comes back rounded to two or three digits (SC-1565).
- **Env**: none (no key).
- **Rate limit**: namespace `exchangerate-api`, 10 requests / 60 s,
  resolved through `OutflowRateLimiterRegistry`. Every caller shares it.
- **Timeout**: 8 s for the whole ask, the wait for a limiter slot
  included. One attempt.
- **Table**: `rateTable(rates, base)` keeps an entry only when it is a
  finite number above zero, and is `null` when no rate but the base's
  own is left. An answer whose `base` is not USD is refused.
- **Cache**: a table that was fetched is kept for 60 minutes per process.
  A failed request is not kept, and neither is an answer with no table.
- **Pairs**: `rateBetween(rates, from, to)` is `rates[to] / rates[from]`
  at 28 significant digits, returned as text. It is `null` when either
  currency is missing. Symbols match in any case.

Source of truth: `client.ts`.
