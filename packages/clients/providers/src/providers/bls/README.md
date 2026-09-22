# `bls/`

US Bureau of Labor Statistics, public data API v1.

- **Upstream**: `https://api.bls.gov/publicAPI/v1/timeseries/data/`.
- **Capabilities**: none in the registry. `BlsClient.fetchMonthly` reads one
  series; the returns card's inflation line uses CPI-U (`CUUR0000SA0`).
- **Env**: none (v1 needs no key).
- **Rate limit**: 25 requests a day per IP upstream, at most ten years per
  request. One request a night, from the benchmark backfill.
- **Notes**: monthly values, published mid-month for the month before, so the
  latest month usually trails today by one to two months.
