# `@scani/providers`

The unified third-party integration layer. Owns every outbound call to
pricing APIs (CoinGecko, Finnhub, DeFiLlama, Frankfurter), CEX accounts
(11 venues), broker APIs (IBKR, Wise), public chains (Bitcoin, Solana,
TRON, TON, Etherscan-multichain), AI inference (OpenAI, Perplexity,
DeepSeek), and the manual-pricing Google Sheets fallback.

Every provider conforms to one or more **capability interfaces** in
`core/capabilities.ts`. The `ProviderRegistry` (`core/registry.ts`)
slots each provider into capability-scoped buckets via duck-typed
guards, and orchestrators (`PricingService`, `WalletDiscoveryService`,
`TransactionImportCoordinator`, etc.) dispatch by capability + token.

## Folder layout

```
src/
├── index.ts                       barrel — re-exports `core/*`
├── core/
│   ├── boot.ts                    buildProviderRegistry({ mode, redis, env, providers })
│   ├── capabilities.ts            9 capability interfaces + duck-typed guards
│   ├── config.ts                  loadProvidersConfig() — package-owned env shape
│   ├── credential-pool.ts         cross-user credential borrow + quarantine
│   ├── errors.ts                  ProviderError + classifyError + .fromHttp(res)
│   ├── rate-limiter-registry.ts   single namespace map (boot fails on duplicates)
│   ├── registry.ts                capability-bucketed dispatch
│   ├── testing.ts                 createMockContext, replayHttp, assertImplementsCapability
│   ├── types.ts                   PriceQuote, HoldingSnapshot, TransactionEvent, ProviderContext
│   ├── base/
│   │   ├── base-cex-provider.ts        pagination + asset-identity for stream-history CEX (Kraken)
│   │   ├── base-hmac-cex-provider.ts   signed-HTTP scaffolding for the 11 simpler CEX
│   │   └── base-evm-provider.ts        EVM-chain scaffolding (Etherscan)
│   ├── cloud/                     cloud-mode capability proxies + factory helpers
│   │                              (data-provider tRPC bridge in @scani/cloud-client)
│   └── utils/
│       └── fetch.ts               fetchWithTimeout — every provider's HTTP path
├── providers/
│   ├── _chat-completions.ts       shared chat-completions client (OpenAI/Perplexity/DeepSeek)
│   └── <name>/                    one directory per provider (28 today; see list below)
└── tests/
    ├── core/                      capabilities, registry, errors, config, rate-limiter, base, fetch
    └── providers/                 representative provider tests (binance)
```

## Capability model

| Capability             | Interface                       | Examples                            |
| ---------------------- | ------------------------------- | ----------------------------------- |
| `current-price`        | `CurrentPriceProvider`          | CoinGecko, Finnhub, Frankfurter, DeFiLlama |
| `historical-price`     | `HistoricalPriceProvider`       | CoinGecko, Frankfurter, Kraken      |
| `current-balances`     | `BalanceProvider`               | every CEX, every chain, IBKR, Wise  |
| `transactions`         | `TransactionsProvider`          | Kraken, Etherscan, Solana, TRON, IBKR |
| `token-identity`       | `TokenIdentityProvider`         | CoinGecko, Finnhub                  |
| `credential-validator` | `CredentialValidator`           | every CEX, IBKR, Wise               |
| `account-discoverer`   | `AccountDiscoveryProvider`      | IBKR, Wise                          |
| `address-validator`    | `AddressValidatorProvider`      | every chain                         |
| `ai-inference`         | `AIInferenceProvider`           | OpenAI, Perplexity, DeepSeek        |

Registration is **duck-typed**: a provider class doesn't need to declare
which interfaces it implements. The registry runs `is*Provider(provider)`
guards for every capability and slots the instance into every bucket
that returns `true`. A typo in a method name silently disables a
capability — `assertImplementsCapability(provider, 'transactions')`
in tests catches that before it becomes a "no transactions provider for
institutionCode='kraken'" runtime surprise.

## Modes — `direct` vs `cloud`

`buildProviderRegistry({ mode, ... })`:

- **`direct`** — the default. The factories construct real provider
  instances that talk to upstream APIs (CoinGecko, Binance, OpenAI,
  …) directly. Apps that boot in direct mode need every per-provider
  API key set in their env.

- **`cloud`** — every capability slot is filled with a proxy from
  `core/cloud/` (`CloudCurrentPricer`, `CloudBalanceFetcher`,
  `CloudAIProvider`, …) that forwards calls to a `CloudProviderClient`
  the app supplies. The `CloudProviderClientBridge` in
  `@scani/cloud-client/cloud-services/cloud-provider-client.ts`
  implements that interface by translating to tRPC calls against
  `apps/backend/data-provider`.

  **Status**: cloud-mode boot is *constructible* today (factories +
  bridge exist) but the data-provider only exposes the AI tRPC routes
  (`ai.parseScreenshot` / `parseDocumentText` / `completeText`).
  Pricing, balances, transactions, and token-identity routes still
  need to be added; the bridge throws `not-supported` for those
  methods until they are. See "Follow-ups" below.

## Boot

```ts
import { buildProviderRegistry } from '@scani/providers/core/boot';
import { coingeckoFactory } from '@scani/providers/providers/coingecko';
import { aiOpenAIFactory } from '@scani/providers/providers/ai-openai';
// … etc.

await buildProviderRegistry({
  mode: 'direct',
  redis: providerRedis,
  env: process.env,
  providers: [
    coingeckoFactory,
    finnhubFactory,
    aiOpenAIFactory,
    // order = dispatch priority
  ],
});
```

Cloud-mode wiring (when the data-provider routes are ready):

```ts
import { buildProviderRegistry } from '@scani/providers/core/boot';
import {
  makeCloudCurrentPricerFactory,
  makeCloudAIProviderFactory,
} from '@scani/providers/core/cloud';
import { CloudProviderClientBridge } from '@scani/cloud-client/cloud-services/cloud-provider-client';
import { getCloudClient } from '@scani/cloud-client/runtime';

const client = getCloudClient();
if (!client) throw new Error('cloud mode requires SCANI_CLOUD_URL');
const bridge = new CloudProviderClientBridge(client);

await buildProviderRegistry({
  mode: 'cloud',
  cloudClient: bridge,
  env: process.env,
  providers: [
    makeCloudCurrentPricerFactory('coingecko'),
    makeCloudCurrentPricerFactory('finnhub'),
    makeCloudAIProviderFactory('openai'),
  ],
});
```

## Adding a new provider

1. `mkdir packages/clients/providers/src/providers/<name>/`
2. Add `index.ts` exporting:
   - A class implementing one or more capability interfaces.
   - A `<name>Factory: ProviderFactory` that constructs the class
     given `deps` (env, redis, rate-limiter-registry, …).
3. Pick a base:
   - **Signed-HTTP CEX** (HMAC-style auth, balance + creds-validate
     mostly) → extend `BaseHmacCexProvider`. Subclass implements
     `signRequest()` for the venue's signing math; the base owns
     rate-limit execution, error wrapping into `ProviderError`, and
     credential extraction.
   - **Stream-history CEX** (paginated transactions, asset-identity
     mapping) → extend `BaseCexProvider`. Subclass implements
     `mapAssetIdentity()` + `fetchHistoryPaginated()`; the base owns
     sign-by-kind enforcement and `Partial<NewToken>` translation.
   - **EVM chain** → extend `BaseEvmProvider`.
   - **Anything else** → implement the capability interfaces directly.
4. Use `fetchWithTimeout` from `core/utils/fetch.ts` for every HTTP
   call (timeout + 429/5xx retry + URL pre-validation).
5. Throw `ProviderError` from `core/errors.ts` (or
   `ProviderError.fromHttp(this.providerKey, res)`) — never
   `new Error('X HTTP 401')`. Lets the registry's classifier route the
   error to retry / quarantine / surface paths.
6. Register the factory in the consuming app's
   `buildProviderRegistry({ providers: [..., <name>Factory] })` call.
7. Add a short `README.md` in your provider directory documenting the
   upstream API base URL, env vars, capabilities, special notes
   (auth quirks, pagination notes, known gaps).
8. Add a test under `tests/providers/<name>.test.ts` using
   `core/testing.ts`'s `createMockContext` + `replayHttp` helpers.

## Env vars

Owned by `core/config.ts` (zod-validated; every field optional because
providers are conditionally active). Apps that depend on
`@scani/providers` MUST NOT redeclare these in their own env schemas.

| Env var                       | Used by                       |
| ----------------------------- | ----------------------------- |
| `COINGECKO_API_KEY`           | CoinGecko (raises rate cap)   |
| `FINNHUB_API_KEY`             | Finnhub                       |
| `ETHERSCAN_API_KEY`           | Etherscan multichain          |
| `HELIUS_API_KEY`              | Solana (Helius RPC)           |
| `OPENAI_API_KEY`              | OpenAI                        |
| `OPENAI_VISION_MODEL`         | OpenAI vision model override  |
| `GOOGLE_SHEETS_ID`            | GoogleSheetsProvider          |
| `GOOGLE_SERVICE_ACCOUNT_KEY`  | GoogleSheetsProvider          |

Per-user CEX credentials (apiKey / apiSecret / passphrase) live in
`user_integration_credentials` (encrypted via `@scani/security`) and
arrive at the provider via `ctx.resolveCredentials(ctx.credentialsRef)`,
not via env.

## Credential pool

`CredentialPool` (`core/credential-pool.ts`) lets pool-credentialed
providers (CoinGecko, Finnhub) borrow any user's API credentials at
request time. Borrows are health-tracked: a credential that returns
`UPSTREAM_ERROR` gets quarantined for the namespace's rate-limit
window, then returns to the pool. Self-credentialed providers (every
CEX, IBKR, Wise) bypass the pool — they only ever use the
session-scoped `ctx.credentialsRef`.

The `WithUserCreds<T>` type brand on `BalanceProvider.fetchBalances`
+ `TransactionsProvider.fetchTransactions` makes passing a context
without `credentialsRef` a compile-time error, so the compiler refuses
to route a pool credential into a balance fetch.

## Tests

```bash
bun test --preload ./packages/business/domain/test-preload.ts \
  packages/clients/providers --timeout 30000
```

Tests use `core/testing.ts` helpers (`createMockContext`,
`makeMockToken`, `assertImplementsCapability`, `replayHttp`,
`as*Provider`) so a typo in a capability method name fails loudly at
test time.

## Follow-ups

- **F1** — Per-provider READMEs are flesh-and-blood for the 7
  most-touched venues (CoinGecko, DeFiLlama, Etherscan, Kraken,
  Binance, IBKR, Wise) — full upstream URL, capability table, auth
  shape, env vars, rate limit + namespace, error taxonomy, known
  quirks, and pointer files. The remaining 20 stubs match the
  original short-form pattern; flesh out as the venues evolve.
- ~~**F2** — Cloud-mode bridge coverage~~. Mostly done.
  `CloudProviderClientBridge` is now live for:
  - `ai.{parseScreenshot, parseDocumentText, completeText}`
  - `pricing.{fetchCurrentPrice, fetchCurrentPrices, fetchHistoricalPrice,
    fetchHistoricalRange}`
  - `tokens.enrichIdentity`

  **Intentionally not implemented**: `fetchBalances` and
  `fetchTransactions`. Both are user-credentialed (CEXes, brokers, IBKR
  Flex Query). Routing them through data-provider would require sending
  decrypted user credentials over the wire on every sync, which is the
  architectural boundary we keep intact. Backend in cloud mode runs a
  small direct-mode sub-registry for those venues.
- ~~**F3** — `googleapis` (~160MB) is a top-level dep~~. Done.
  GoogleSheetsProvider now lives in its own sub-workspace
  `@scani/providers-google-sheets` with `googleapis` as the only
  unique dep. PricingService obtains it via the registry instead of
  `new GoogleSheetsProvider(...)` — backend + worker boot construct
  it via `googleSheetsFactory(...)` and `registry.register(...)` it.
  data-provider keeps its registry Google-Sheets-free (no per-user
  DB state in cloud-mode). Domain code (`@scani/domain`) no longer
  carries `googleapis` transitively; only api + worker do.
- ~~**F4** — `BaseCexProvider` + `BaseEvmProvider` deeper test coverage~~.
  Done. `tests/core/base/{base-cex-provider,base-evm-provider}.test.ts`
  cover sign-by-kind enforcement, counter/fee sign inference,
  asset-identity skip-on-unknown, page advancement + infinite-loop
  guard, since/until filtering, and the chain-config dispatch path.
  Concrete provider tests (Kraken / Etherscan / Binance) still
  exercise the wiring end-to-end on top.
- **F5** — Coinbase OAuth migration support. Today its API-key path
  works through `BaseHmacCexProvider`; an OAuth-bearer mode would
  bypass `signRequest` entirely. Add as a `signRequest` variant when
  the OAuth flow lands.
