# `frankfurter/`

Fiat FX rates from named central banks, through Frankfurter v2.

- **Upstream**: `https://api.frankfurter.dev/v2/providers/{ecb|cbr}/rates`.
  Never the unnamed `/v2/rates` blend, which mixes sources of different dates.
- **Capabilities**: `current-price`, `historical-price`.
- **Env**: none (free, no key required).
- **Rate limit**: namespace `frankfurter`, 10 requests a second, taken from
  `OutflowRateLimiterRegistry` at each ask; one 8 s bound covers the wait for a
  slot and the request.
- **`client.ts`** is the one client, shared by this provider and the Google
  Sheets converter:
  - A pair both of whose currencies the European Central Bank publishes (USD
    among them) is read from the ECB's table, asked in EUR. A pair with a
    currency only the Bank of Russia publishes (RUB, KZT, AED, …) is read from
    the Bank of Russia's table, asked in USD. Both sides always from one bank;
    a currency in neither table is not priced here. The two code lists are
    static, with their date of reading in a comment.
  - A bank's own figure comes back only in the direction it publishes, so the
    pair is divided here, at 28 significant digits:
    `rate(pivot to B) / rate(pivot to X)`.
  - Each bank's latest table is kept for 60 minutes per process; a day or a
    range is asked every time; a failure is never kept. An answer in another
    base, or with no positive rate, is refused whole.
- **Quotes**: a current quote is stamped at its fixing day at 00:00 UTC with no
  close day. A day or a range quote is the close of the day its row names, which
  on a weekend or holiday is the last fixing before the day asked. Sources:
  `frankfurter` / `frankfurter_historical` for the ECB, `frankfurter-cbr` /
  `frankfurter-cbr_historical` for the Bank of Russia.
- **Attribution**: [ECB euro reference rates](https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html),
  [Bank of Russia official rates](https://www.cbr.ru/eng/currency_base/daily/).
