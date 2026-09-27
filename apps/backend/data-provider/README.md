# @scani/data-provider

Scani's shared platform-processing service. Tier 2 API and worker instances
call it with one Scani Cloud key for AI, pricing, token lookup, supported public
wallet requests and fixed authentication email templates. Their database and
S3 remain customer-owned; the bundled S3 engine is SeaweedFS.

| Tier | Processing | Storage and credentials |
|------|------------|-------------------------|
| 1 — Self-hosted | Direct providers in the local API/worker; local data-provider for token search and metadata | Local S3/mail; own platform keys where required; installer-generated sidecar bearer |
| 2 — Cloud processing | Scani-hosted data-provider, selected by `SCANI_DEPLOYMENT_TIER=2` | Local S3/database; one Scani Cloud key; personal exchange/broker credentials stay local |
| 3 — Managed | Existing managed routing | Scani-owned infrastructure and internal service credentials |

Tier 2 sends the inputs needed for processing to Scani Cloud. It does not send
its durable database or S3 bucket there. Salt Edge through the cloud is future work.

## Scope

Only the centralized third-party integrations live here. Exchange and
brokerage calls that need per-user credentials (Binance, Kraken, Bybit,
OKX, Coinbase, IBKR, Wise, …) stay in the api + worker so user creds
never leave the tenant boundary.

| Domain | tRPC router | Availability |
|--------|-------------|--------------|
| AI, prices and public-wallet operations | `processing.v1.*` | Customer and internal keys; Scani-owned upstream accounts |
| Token search | `tokens.*` | Customer and internal keys; CoinGecko, DeFiLlama, Finnhub |
| Legacy public-chain operations | `chains.*` | Existing public-chain API |
| Authentication mail | `email.auth` | Fixed templates, same-origin links, owner/recipient limits |
| Generic mail and object storage | `email.send`, `storage.*` | Internal keys only; never Tier 2 customer storage |
| Open Graph | `og.fetchMetadata` | SSRF-hardened metadata fetch |

The adapters in [`@scani/cloud-client`](../../../packages/clients/cloud-client/)
select cloud platform providers only for Tier 2. Personal exchange and brokerage
operations remain local. Tier 1 uses direct providers, and unset/Tier 3 preserves
managed routing. Provider keys belong on the Scani processing service for Tier 2,
not on customer API or worker instances.

`processing.v1.capabilities` reports the active pricing and AI providers. A
successful `/health` response alone does not establish processing availability.
AI requests have bounded inputs, a cancellation deadline and owner-scoped replay
protection; replayed results do not count as additional upstream spend. Small AI
results are cached briefly in Redis, as disclosed in the self-hosting guide.

## Boot

Env schema lives in [`src/config/env.ts`](src/config/env.ts). The key you'll
care about first:

- `DATA_PROVIDER_API_KEY` — internal/sidecar bearer. Tier 1's generated value
  matches `SCANI_CLOUD_API_KEY` on its local API and worker. Managed customer
  keys are validated separately against `cloud_api_keys`; customers never
  receive the internal bearer.
- `REDIS_URL` — backs the per-provider rate-limiter buckets so horizontal
  replicas share the upstream API budget.
- Provider keys (`OPENAI_API_KEY`, `ETHERSCAN_API_KEY`, …) — optional at
  the schema level. A router throws `PRECONDITION_FAILED` at call-time
  if its provider is unconfigured.

```bash
bun install
# data-provider only
bun --cwd apps/backend/data-provider dev
# or spin up the whole stack (api + worker + data-provider + infra)
bun run dev:stack
```

HTTP health: `curl http://localhost:8082/health`.

## Deploy

The service ships as a multi-stage Bun Docker image (see
[`Dockerfile`](./Dockerfile)) and runs on any container host. Because
cloud processing depends on this service, run multiple replicas when
availability requires rolling deployments without processing downtime. Per-provider rate-limiter buckets live in Redis, so
replicas share fairness without coordination — to raise capacity, add
replicas and ensure each provider's per-key budget can absorb the
larger fan-out. Prefer a rolling deploy strategy.

## Cloud management (Tier 2/3)

Set `CLOUD_MANAGEMENT_ENABLED=true` plus `DATABASE_URL`, `BETTER_AUTH_URL`,
`BETTER_AUTH_SECRET`, and `CLOUD_FRONTEND_ORIGIN` to turn on:

- **DB-backed `cloud_api_keys`** for per-tenant auth (with env-key fallback
  for self-hosters).
- **Better-Auth cookie sessions** at `/api/auth/*` for the management
  console.
- **Postgres per-request metering** — every tRPC call is written to
  `cloud_usage_events` with `subject=<cloud_user.id>`, buffered in memory
  and flushed in batches. The `/usage` dashboard aggregates in SQL
  (`usage.*` routers).

## Observability

- Structured logs via `@scani/logging` with per-request `requestId`
  propagation (the api generates `x-request-id`; this service stamps
  logs + the Sentry scope with the same value so traces stitch).
- Rate-limit buckets are namespaced `dp:<provider>` in Redis so they do
  not collide with api buckets that share the same Redis.
- On 5xx the client-side `CloudError` wrapper preserves the inner tRPC
  code + message so api logs point at the real upstream cause
  (OpenAI rate-limit vs Etherscan 4xx etc.).
