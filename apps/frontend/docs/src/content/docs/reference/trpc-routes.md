---
title: tRPC route catalogue
description: Every router exposed by the api and the data-provider, with a one-line role description.
sidebar:
  order: 5
---

The api and data-provider expose tRPC routers under `presentation/`.
This page enumerates the routers; precise input / output shapes live
with the code (`packages/business/shared/src/` for the wire DTOs).

## api (apps/backend/api)

Located in `apps/backend/api/src/presentation/routers/`.

| Router | Role |
|---|---|
| `users` | Profile, settings, display currency, magic-link / OTP flows. |
| `system` | Public health / version endpoints (e.g. `ping`). The typed slice exposed to the mobile OpenAPI contract. |
| `sessions` | Session read / revoke. |
| `accounts` | List, create, update, hide accounts. |
| `account-types` | Catalogue of account types. |
| `institutions` | List institutions. Create the synthetic *manual* institution. |
| `institution-types` | Catalogue of institution types. |
| `holdings` | CRUD on holdings, set/unset APY config, attach to vault / group. |
| `tokens` | Search tokens, materialise via `TokenIdentityService`. |
| `transactions` | Read the ledger. Filter by date range, kind, account, holding, transfer group. |
| `vaults` | CRUD on vaults, attach/detach holdings with percentage splits. |
| `groups` | CRUD on groups, attach holdings + accounts. |
| `portfolio` | Dashboard headline + chart series (reads `portfolio_value_daily`). |
| `dashboard` | Aggregate dashboard data — composes calls to `portfolio` + per-scope rollups. |
| `integrations` | Connect / disconnect provider integrations (Binance OAuth, exchange API keys, brokerage tokens, wallets). Owns encrypt/decrypt of credentials. |
| `wallet` | Add / discover on-chain wallets. |
| `screenshots` | Upload screenshot to S3, enqueue `screenshot-parse` job. |
| `file-import` | Upload CSV / file, enqueue `file-import` job. |
| `storage` | Presigned URL minting for direct S3 reads. |
| `jobs` | HMAC-gated operator endpoints: retry, remove, DLQ replay. |
| `batch-operations` | Batched mutations the SPA uses for bulk edits. |
| `client-errors` | Endpoint the SPA posts unhandled-error reports to. |

Auth: every router except the user-facing magic-link entry points
requires a Better-Auth session cookie. The `jobs` router additionally
requires an HMAC signature using `JOBS_HMAC_SECRET`.

## data-provider (apps/backend/data-provider)

Located in `apps/backend/data-provider/src/presentation/routers/`.
Composed in `apps/backend/data-provider/src/presentation/router.ts`.

| Router | Auth | Role |
|---|---|---|
| `pricing` | Bearer | Current and historical prices via the routed provider stack (CoinGecko, Finnhub, DeFiLlama, Frankfurter, Yahoo Finance). |
| `chains` | Bearer | Blockchain balance + transaction reads (Etherscan V2 across EVM chains, Helius for Solana, Bitcoin RPC, Tron, TON, ENS). |
| `ai` | Bearer | Screenshot parsing (OpenAI Vision). Optionally Perplexity / DeepSeek for token-identity assistance. |
| `tokens` | Bearer | Identity-related calls used by `TokenIdentityService` (CoinGecko slug lookup, Etherscan contract lookup, …). |
| `email` | Bearer | `email.send` — used by the api to send magic-link / OTP / verification emails. |
| `storage` | Bearer | Presigned URL minting + the rare server-side read path. The only service that holds S3/R2 credentials; api + worker request presigned URLs from here so creds never leave the data-provider. |
| `og` | Bearer | Open Graph metadata fetch (used by the SPA's link previews). |
| `contact` | Public | Landing-page contact form: validates a submission, emails support, sends a receipt. Per-IP rate-limited. No bearer (called from the public marketing site). |
| `keys` | Cookie | Cloud-management surface (`CLOUD_MANAGEMENT_ENABLED=true`): mint, list, revoke cloud API keys scoped to the authenticated cloud user. |
| `usage` | Cookie | Cloud-management read-API: per-user / per-tier usage aggregation from `cloud_usage_events`. |

Auth column: **Bearer** = `DATA_PROVIDER_API_KEY` (every api / worker call). **Cookie** = Better-Auth session, only available when `CLOUD_MANAGEMENT_ENABLED=true` and the data-provider is fronted by the cloud-frontend. **Public** = no auth (rate-limited per-IP).

## Wire contracts

Input / output shapes are zod schemas in
`packages/business/shared/src/`. Every router's payload schema is
also the source of truth for the SPA's tRPC client types.

## How calls are gated

Three gates fire in order:

1. **Bearer / cookie auth.** No bearer / cookie → `UNAUTHORIZED`.
2. **Capability gate.** A call needing a provider key (e.g.
   `ai.parseScreenshot` needs `OPENAI_API_KEY`) returns
   `PRECONDITION_FAILED` when unconfigured.
3. **Rate limit.** Per-provider rate limiter
   (`@scani/rate-limiter`) returns `TOO_MANY_REQUESTS` when the
   upstream's quota is hit. The api retries via BullMQ's retry
   policy.

## Adding a new router

1. Create the router file in the appropriate
   `src/presentation/routers/` directory.
2. Define the input / output zod schema in
   `packages/business/shared/src/`.
3. Register the router in the app's root router (`index.ts`
   alongside the existing routers).
4. The SPA's tRPC client picks it up automatically via the
   end-to-end-typed client factory.

## See also

- [Repo layout](/reference/repo-layout/)
- [Database schema](/reference/database-schema/)
- [Job catalogue](/reference/jobs/)
- [Engineering conventions](/contributing/conventions/)
