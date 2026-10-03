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
│   ├── errors.ts                  ProviderError + classifyError + .fromHttp(res)
│   ├── rate-limiter-registry.ts   single namespace map (boot fails on duplicates)
│   ├── registry.ts                capability-bucketed dispatch
│   ├── testing.ts                 createMockSelfCredContext, makeMockToken
│   ├── types.ts                   PriceQuote, HoldingSnapshot, TransactionEvent, ProviderContext
│   ├── base/
│   │   ├── base-cex-provider.ts        pagination + asset-identity for stream-history CEX (Kraken)
│   │   ├── base-hmac-cex-provider.ts   signed-HTTP scaffolding for the 11 simpler CEX
│   │   └── base-evm-provider.ts        EVM-chain scaffolding (Etherscan)
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
capability, so a provider's test calls the capability method it claims
before that becomes a "no transactions provider for
institutionCode='kraken'" runtime surprise.

## Provider selection by deployment tier

`buildProviderRegistry()` constructs the factories selected by each app's
composition root. Tier 1 uses direct platform providers. Tier 2 wraps platform
factories with `platformProviderFactories` from `@scani/cloud-client`, replacing
AI, market-data, token-identity and public-wallet capabilities with cloud
adapters. Those adapters call the Scani-hosted data-provider using one cloud key.

`personalProviderFactories` keeps credentialed exchange and brokerage operations
local while routing their public pricing methods through the cloud. Decrypted
personal credentials never cross that boundary. Tier 2 S3 also stays local;
cloud processing receives only its required inputs. Unset/Tier 3 retains the
existing managed provider selection.

The cloud service constructs the direct upstream providers with Scani-owned
keys. Redis-backed provider rate limits remain shared across its replicas;
adding a process must not multiply an upstream budget. Customer API/worker
instances do not need those platform keys in Tier 2.

## Boot

```ts
import { buildProviderRegistry } from '@scani/providers/core/boot';
import { coingeckoFactory } from '@scani/providers/providers/coingecko';
import { aiOpenAIFactory } from '@scani/providers/providers/ai-openai';
// … etc.

await buildProviderRegistry({
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
   `core/testing.ts`'s `createMockSelfCredContext` + `makeMockToken` helpers.

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
| `GOOGLE_SHEETS_ID`            | GoogleSheetsProvider          |
| `GOOGLE_SERVICE_ACCOUNT_KEY`  | GoogleSheetsProvider          |

Per-user CEX credentials (apiKey / apiSecret / passphrase) live in
`user_integration_credentials` (encrypted via `@scani/security`) and
arrive at the provider via `ctx.resolveCredentials(ctx.credentialsRef)`,
not via env.

## Credentials

Self-credentialed providers (every CEX, IBKR, Wise) use only the
session-scoped `ctx.credentialsRef`. The `WithUserCreds<T>` type brand on
`BalanceProvider.fetchBalances` + `TransactionsProvider.fetchTransactions`
makes passing a context without `credentialsRef` a compile-time error.

**A `CredentialPool` that would have let platform-credentialed providers
borrow any user's API credentials at request time was deleted in
SC-1022**, having been constructed and wired at boot with its one
functional method called from nowhere. Its two bookkeeping tables
(`credential_pool_state`, `credential_pool_borrow_log`) are deliberately
retained — see `packages/infra/db/src/schema/user-integration-credentials.ts`.

## Tests

```bash
bun test --preload ./packages/business/domain/test-preload.ts \
  packages/clients/providers --timeout 30000
```

Tests use `core/testing.ts` helpers (`createMockSelfCredContext`,
`makeMockToken`).

## Follow-ups

- **F1** — Per-provider READMEs are flesh-and-blood for the 7
  most-touched venues (CoinGecko, DeFiLlama, Etherscan, Kraken,
  Binance, IBKR, Wise) — full upstream URL, capability table, auth
  shape, env vars, rate limit + namespace, error taxonomy, known
  quirks, and pointer files. The remaining 20 stubs match the
  original short-form pattern; flesh out as the venues evolve.
- ~~**F2** — Cloud-mode bridge coverage~~. Moot. The bridge and the
  routers it called were deleted in SC-587; there is no second egress
  path left to cover.
- ~~**F3** — `googleapis` (~160MB) is a top-level dep~~. Done.
  GoogleSheetsProvider now lives in its own sub-workspace
  `@scani/providers-google-sheets` with `googleapis` as the only
  unique dep. PricingService obtains it via the registry instead of
  `new GoogleSheetsProvider(...)` — backend + worker boot construct
  it via `googleSheetsFactory(...)` and `registry.register(...)` it.
  data-provider keeps its registry Google-Sheets-free (it holds no
  per-user DB state). Domain code (`@scani/domain`) no longer
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
