# @scani/data-provider

The one process that talks to the outside world.

The api and worker never call a third-party API directly; they hit this
service over tRPC with `Authorization: Bearer <SCANI_CLOUD_API_KEY>`.
That lets the same api+worker binaries run across all three deployment
tiers:

| Tier | Data-provider runs on | `SCANI_CLOUD_URL` | `SCANI_CLOUD_API_KEY` |
|------|----------------------|-------------------|-----------------------|
| 1 — Self-hosted | the user's own box (docker-compose) | `http://data-provider:8082` | user-picked shared secret |
| 2 — Semi-managed | a hosted data-provider | the hosted endpoint | issued paid key |
| 3 — SaaS | a hosted data-provider | the hosted endpoint | issued key |

## Scope

Only the centralized third-party integrations live here. Exchange and
brokerage calls that need per-user credentials (Binance, Kraken, Bybit,
OKX, Coinbase, IBKR, Wise, …) stay in the api + worker so user creds
never leave the tenant boundary.

| Domain | tRPC router | Upstream |
|--------|-------------|----------|
| Pricing | `pricing.*` | CoinGecko, Finnhub, DeFiLlama, ExchangeRate-API, Google Sheets |
| AI / LLM | `ai.*` | OpenAI, Perplexity, DeepSeek |
| Public chains | `chains.*` | Etherscan V2, Solana (Helius / public), Bitcoin, Tron, TON, ENS |
| Email | `email.send` | Fastmail JMAP (falls back to SMTP) |
| Object storage | `storage.*` | S3-compatible storage (presign + read + delete) |
| Open Graph | `og.fetchMetadata` | SSRF-hardened HTML fetch + `open-graph-scraper` |

Every router has a matching `Cloud*` adapter in
[`packages/clients/cloud-client`](../../../packages/clients/cloud-client/) so the
domain services in `packages/business/domain` can swap the real implementation
for a cloud-backed one without code-site churn.

## Boot

Env schema lives in [`src/config/env.ts`](src/config/env.ts). The key you'll
care about first:

- `DATA_PROVIDER_API_KEY` — the bearer this service validates on every
  incoming request. It must match `SCANI_CLOUD_API_KEY` on the api +
  worker.
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
every api + worker call now hops through this service, run at least two
replicas so a single-machine cutover during deploy doesn't 5xx every
outbound request. Per-provider rate-limiter buckets live in Redis, so
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
