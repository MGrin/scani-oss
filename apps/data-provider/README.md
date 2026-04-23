# @scani/data-provider

The one process that talks to the outside world.

Backend and worker never call a third-party API directly anymore; they
hit this service over tRPC with `Authorization: Bearer <SCANI_CLOUD_API_KEY>`.
That lets the same backend+worker binaries run across all three Scani
deployment tiers:

| Tier | Data-provider runs on | `SCANI_CLOUD_URL` | `SCANI_CLOUD_API_KEY` |
|------|----------------------|-------------------|-----------------------|
| 1 — OSS self-hosted | the user's own box (docker-compose) | `http://data-provider:8082` | user-picked shared secret |
| 2 — Semi-managed | `api.cloud.scani.xyz` (Scani-hosted) | `https://api.cloud.scani.xyz` | Scani-issued paid key |
| 3 — SaaS | `api.cloud.scani.xyz` (Scani-hosted) | `https://api.cloud.scani.xyz` | Scani-internal zero-billing key |

The matching cloud-frontend console lives at `cloud.scani.xyz` (Cloudflare
Pages); it talks to the data-provider at `api.cloud.scani.xyz` for key
management + usage dashboards.

## Scope

Only the **Scani-owned** third-party integrations live here. Exchange and
brokerage calls that need per-user credentials (Binance, Kraken, Bybit,
OKX, Coinbase, IBKR, Wise, …) stay in `apps/backend` + `apps/worker` so
user creds never leave the tenant boundary.

| Domain | tRPC router | Upstream |
|--------|-------------|----------|
| Pricing | `pricing.*` | CoinGecko, Finnhub, DeFiLlama, ExchangeRate-API, Google Sheets |
| AI / LLM | `ai.*` | OpenAI, Perplexity, DeepSeek |
| Public chains | `chains.*` | Etherscan V2, Solana (Helius / public), Bitcoin, Tron, TON, ENS |
| Email | `email.send` | Fastmail JMAP (falls back to SMTP) |
| Object storage | `storage.*` | Cloudflare R2 (presign + read + delete) |
| Open Graph | `og.fetchMetadata` | SSRF-hardened HTML fetch + `open-graph-scraper` |

Every router has a matching `Cloud*` adapter in
[`packages/cloud-client`](../../packages/cloud-client/) so the domain
services in `packages/domain` can swap the real implementation for a
cloud-backed one without code-site churn.

## Boot

Env schema lives in [`src/config/env.ts`](src/config/env.ts). The key you'll
care about first:

- `DATA_PROVIDER_API_KEY` — the bearer this service validates on every
  incoming request. In Tier 1 it's whatever the user picks (must match
  `SCANI_CLOUD_API_KEY` on backend+worker). In Tier 2/3 it's Terraform-
  generated (`random_password.scani_cloud_api_key` in `infra/terraform`).
- `REDIS_URL` — backs the per-provider rate-limiter buckets so horizontal
  replicas share the upstream API budget.
- Provider keys (`OPENAI_API_KEY`, `ETHERSCAN_API_KEY`, …) — optional at
  the schema level. A router throws `PRECONDITION_FAILED` at call-time
  if its provider is unconfigured.

```bash
bun install
# data-provider only
bun --cwd apps/data-provider dev
# or spin up the whole stack (backend + worker + data-provider + infra)
bun run dev:stack
```

HTTP health: `curl http://localhost:8082/health`.

## Deploy

- Fly app `scani-data-provider` (see [`infra/terraform/fly.tf`](../../infra/terraform/fly.tf)).
- Sentry project `scani-data-provider` (see [`infra/terraform/sentry.tf`](../../infra/terraform/sentry.tf)).
- GitHub Actions job `deploy-data-provider` in
  [`.github/workflows/deploy-fly.yaml`](../../.github/workflows/deploy-fly.yaml)
  pushes every provider secret the service needs from GH Secrets onto Fly
  before `flyctl deploy`, then runs `/health` as a smoke test. Backend +
  worker deploys are `needs:`-chained on this job to avoid a window where
  they're pointed at a stale data-provider.

### Replicas + rolling deploy

Two machines (`min_machines_running = max_machines_running = 2`) is the
floor: every backend + worker call now hops through this service, so a
single-machine cutover during deploy would 5xx every outbound request
for ~30s. Per-provider rate-limiter buckets live in Redis so the two
replicas share fairness without coordination. To raise capacity, bump
both bounds together (and ensure each provider's per-key budget can
absorb the new fan-out).

The deploy strategy is `rolling` with `max_unavailable = 1` (set in
[`fly.toml`](./fly.toml)); the workflow does NOT pass `--strategy` on
the CLI because that overrides the toml.

## Cloud management (Tier 2/3)

Set `CLOUD_MANAGEMENT_ENABLED=true` plus `DATABASE_URL`, `BETTER_AUTH_URL`,
`BETTER_AUTH_SECRET`, and `CLOUD_FRONTEND_ORIGIN` to turn on:

- **DB-backed `cloud_api_keys`** for per-tenant auth (with env-key fallback
  for OSS).
- **Better-Auth cookie sessions** at `/api/auth/*` for the `cloud.scani.xyz`
  console (`apps/cloud-frontend`).
- **Postgres per-request metering** — every tRPC call is written to
  `cloud_usage_events` with `subject=<cloud_user.id>` (same Neon database
  as `cloud_users`), buffered in memory and flushed in batches. The
  `/usage` dashboard aggregates in SQL (`usage.*` routers).

## Observability

- Structured logs via `@scani/logging` with per-request `requestId`
  propagation (the backend generates `x-request-id`; this service stamps
  logs + the Sentry scope with the same value so traces stitch).
- Rate-limit buckets are namespaced `dp:<provider>` in Redis so they do
  not collide with backend buckets that share the same Redis.
- On 5xx the client-side `CloudError` wrapper preserves the inner tRPC
  code + message so backend logs point at the real upstream cause
  (OpenAI rate-limit vs Etherscan 4xx etc.).
