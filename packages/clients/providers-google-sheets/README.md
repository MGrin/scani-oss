# `@scani/providers-google-sheets`

GoogleSheetsProvider — fallback / manual-override pricing via the user's
Google Sheet wired to GOOGLEFINANCE() formulas. Implements
`@scani/providers/core/capabilities.CurrentPriceProvider` so it slots
into the `ProviderRegistry` like every other pricer.

## Why a separate workspace?

The `googleapis` SDK is ~160MB on disk and is the only dep this provider
needs that isn't already on every other pricer. Pre-F3 it lived inside
`@scani/providers`, which made `@scani/domain` (and through it api,
worker, and data-provider) all carry the SDK transitively.

Splitting it out:

- `@scani/providers` is googleapis-free. Anyone consuming it (`@scani/domain`,
  data-provider) doesn't pay the install/disk cost.
- api + worker explicitly depend on `@scani/providers-google-sheets`
  because their boot wiring constructs and registers the provider.
- data-provider's registry stays Google-Sheets-free (the per-user sheet
  config is backend-side DB state — wouldn't work in cloud-mode anyway).

## Boot wiring

```ts
import { googleSheetsFactory } from '@scani/providers-google-sheets';
import { buildProviderRegistry } from '@scani/providers/core/boot';

const built = await buildProviderRegistry({
  mode: 'direct',
  redis,
  env: process.env,
  providers: [/* coingecko, defillama, finnhub, frankfurter, ... */],
});

const gs = googleSheetsFactory({
  db,                                     // backend's postgres connection
  redis,
  rateLimiterRegistry: built.rateLimiterRegistry,
});
built.registry.register(gs);
```

`PricingService` then obtains the provider via the registry —
`registry.getAllCurrentPricers().find(p => p.providerKey === 'google-sheets')`
— same path as CoinGecko / DeFiLlama / Finnhub.

## Env vars

Reads via `loadProvidersConfig()` (from `@scani/providers/core/config`):

- `GOOGLE_SHEETS_ID` — the spreadsheet id.
- `GOOGLE_SERVICE_ACCOUNT_KEY` — base64-encoded JSON service-account
  credential (`type=service_account`, with `client_email` +
  `private_key` fields). Granted Editor access to the sheet.

When either is missing, the provider's `isAvailable()` returns false
and `canPrice(t)` short-circuits — PricingService treats it as "no
provider registered" via the degraded-adapter path.

## Capability contract

| Capability      | Method                            | Notes                                |
| --------------- | --------------------------------- | ------------------------------------ |
| `current-price` | `fetchCurrentPrice(t, ctx)`       | Single-token wrapper around the batch path. |
|                 | `fetchCurrentPrices(tokens, ctx)` | Batch — preferred path. Reads/writes the sheet directly. |

`canPrice(t)` returns `available && Boolean(t.symbol)`. PricingService's
`groupTokensByProvider` upstream is the actual routing decision (non-US
Finnhub stocks land here, the rest go to Finnhub / CoinGecko).

## Internals

- `google-sheets-provider.ts` — the class + capability surface.
  ~1400 lines of GOOGLEFINANCE row-management.
- `currency-converter.ts` — `GoogleSheetsCurrencyConverter` for
  per-token native→base currency conversion. Uses
  `exchangerate-api.com` with a 10-minute in-memory cache.
- `failure-result.ts` — formats upstream errors into the
  `ProviderPriceResult` shape PricingService consumes.
- `factory.ts` — `googleSheetsFactory(deps)` wires limiters
  (`google-sheets`, `finnhub`, `exchangerate-api`) onto the providers
  package's `RateLimiterRegistry` and constructs the provider.

## Notes / quirks

- Backend-only: reads per-user sheet config from the DB
  (`token.providerMetadata.googleSheets.rowNumber`).
- Postgres advisory lock (`GOOGLE_SHEETS_LOCK_ID = 123456789`)
  serializes cross-process refreshes — Google Sheets API is rate-
  limited per-spreadsheet, not per-app, so concurrent workers would
  thrash without it.
- Only supports live-price requests. Historical pricing falls through
  to the registry's HistoricalPriceProvider chain (DeFiLlama / Kraken
  OHLC / etc.).
