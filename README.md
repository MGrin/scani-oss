# Scani

**Self-hostable, open-source portfolio tracker for crypto and traditional assets.**

One view across every asset you care about — exchanges, on-chain wallets,
brokerages, and manual entries. Same TypeScript codebase runs three ways:
fully self-hosted, against a hosted data-provider, or as a managed
service. MIT licensed.

[![CI](https://github.com/MGrin/scani-oss/actions/workflows/ci.yml/badge.svg)](https://github.com/MGrin/scani-oss/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Bun](https://img.shields.io/badge/runtime-Bun-black.svg)](https://bun.sh)

---

## Quickstart

You need [Bun](https://bun.sh) ≥ 1.3 and Docker (Docker Desktop, OrbStack,
or any compatible runtime).

```bash
git clone git@github.com:MGrin/scani-oss.git
cd scani-oss
cp .env.example .env
bun install
bun run dev:stack        # boots Postgres, Redis, MinIO, Mailpit, api, worker, data-provider, frontend
open http://localhost:5173
```

The stack is self-contained — no external service credentials required.
Auth, holdings, FX pricing, and local screenshot storage (via MinIO) all
work without any API key. Provider API keys (CoinGecko, OpenAI, exchange
read-only keys, …) unlock specific integrations.

To stop:

```bash
bun run dev:stack:down   # containers down, volumes preserved
```

## Self-hosting

### Tier model

The same binaries run three ways. You pick by setting env vars — no
feature flags, no code-level switches.

| Tier | Data-provider runs on | Use case |
|------|----------------------|----------|
| **1 — Fully self-hosted** | The same machine as the rest of the stack (`bun run dev:stack`) | You run everything; ideal for personal use or operators who want full control |
| **2 — Semi-managed** | A hosted data-provider you point at | You run the api + worker + frontend; a hosted endpoint provides centralized 3rd-party access (CoinGecko, OpenAI, Etherscan, …) without you managing the keys |
| **3 — Fully managed** | A fully hosted deployment | Someone else runs the whole stack for you |

The flow between them is just two env vars:

- `SCANI_CLOUD_URL` — where to send outbound 3rd-party requests
  (`http://data-provider:8082` for Tier 1; a hosted endpoint for Tier 2/3)
- `SCANI_CLOUD_API_KEY` — the bearer token the api + worker present

### Environment variables

The full annotated list lives in [`.env.example`](./.env.example). The
must-set ones for any real deployment:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres 16+ connection string |
| `REDIS_URL` | Redis 7+ connection string |
| `BETTER_AUTH_SECRET` | 32+ chars; rotates every session if changed |
| `ENCRYPTION_KEY` | 32 hex chars; must match between api and worker |
| `JOBS_HMAC_SECRET` | Shared secret for HMAC-gated job admin endpoints |
| `FRONTEND_URL` / `BACKEND_URL` | What the browser sees; powers CORS + cookies |
| `S3_*` | Object storage (any S3-compatible store; MinIO locally, R2 / S3 / B2 / … in prod) |
| `SCANI_CLOUD_URL` / `SCANI_CLOUD_API_KEY` | Where the data-provider lives + bearer to reach it |

Optional integration keys (each one unlocks specific functionality —
the corresponding tRPC router returns a `PRECONDITION_FAILED` error
at call-time if unset):

- `COINGECKO_API_KEY`, `FINNHUB_API_KEY` — pricing
- `OPENAI_API_KEY` — screenshot parsing
- `ETHERSCAN_API_KEY` — EVM wallet balances (one key covers all EVM chains)
- `HELIUS_API_KEY` — Solana balances
- `BINANCE_OAUTH_CLIENT_ID` / `_SECRET` / `_REDIRECT_URI` — Binance exchange connection
- `FASTMAIL_API_TOKEN` — magic-link email delivery (or use `SMTP_URL` for any SMTP server)

### Production

For a production deployment, point the four backend services at managed
Postgres, Redis, and S3-compatible storage, set `NODE_ENV=production`,
provide real values for everything `requiredInProd` (the api refuses to
boot otherwise), and run behind your own reverse proxy / TLS.

A reference production compose file (`docker-compose.prod.yml`) is
planned — it will pull pre-built multi-arch images from Docker Hub and
wire them up with the same env vars. See [Roadmap](#roadmap).

## Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│  Browser  ──HTTPS──▶  api (Elysia + tRPC)  ──BullMQ──▶  worker         │
│                            │                             │             │
│                            └──┬──────────────────────────┘             │
│                               │ over tRPC                              │
│                               ▼                                        │
│                       data-provider                                    │
│                  (centralized 3rd-party calls:                         │
│                   CoinGecko, Finnhub, DeFiLlama, OpenAI,               │
│                   Etherscan, Helius, Google Sheets, …)                 │
│                                                                        │
│  Postgres ◀─── api + worker + data-provider (Drizzle)                  │
│  Redis    ◀─── api (BullMQ producer) + worker (BullMQ consumer)        │
│  S3       ◀─── worker (screenshot uploads, file imports)               │
└────────────────────────────────────────────────────────────────────────┘
```

Three deployable Bun services + one SPA:

- **`apps/backend/api`** — tRPC + Elysia HTTP server. Owns per-user
  credentialed integrations (exchange API keys, brokerage tokens) so
  user creds never cross the tenant boundary.
- **`apps/backend/worker`** — BullMQ consumer. Runs every scheduled
  job (pricing refresh, balance syncs, historical backfills, transfer
  linking) and every user-initiated job (screenshot parse, import,
  delete) in one binary.
- **`apps/backend/data-provider`** — tRPC service that centralizes
  outbound 3rd-party calls. The api and worker call it over tRPC rather
  than reaching for upstream APIs directly. This is the seam between
  the tiers: in Tier 1 it's on `localhost:8082`, in Tier 2/3 it's a
  hosted endpoint.
- **`apps/frontend/app`** — React + Vite SPA. tRPC client end-to-end
  type-safe with the api.

State splits as you'd expect: Postgres for everything durable (users,
holdings, transactions, balances, audit log), Redis for BullMQ + the
per-provider rate-limiter buckets + realtime fan-out, an S3-compatible
store for binary uploads.

## Tech stack

- **Runtime**: [Bun](https://bun.sh) (end-to-end — no Node)
- **Type-check**: [`tsgo`](https://github.com/microsoft/typescript-go) (`@typescript/native-preview`) — 5–10× faster than `tsc` on this monorepo
- **Lint + format**: [Biome](https://biomejs.dev) (no ESLint, no Prettier)
- **HTTP**: [Elysia](https://elysiajs.com) + [tRPC](https://trpc.io)
- **Database**: PostgreSQL via [Drizzle ORM](https://orm.drizzle.team)
- **Async jobs**: [BullMQ](https://docs.bullmq.io) on Redis, with Postgres advisory locks for cron idempotency
- **Auth**: [Better-Auth](https://better-auth.com) (sessions in Postgres)
- **Storage**: S3-compatible via [`@aws-sdk/client-s3`](https://github.com/aws/aws-sdk-js-v3)
- **Email**: Fastmail JMAP API or any SMTP server
- **Frontend**: React + Vite + [Tailwind](https://tailwindcss.com) + [shadcn/ui](https://ui.shadcn.com)
- **Dependency injection**: [typedi](https://github.com/typestack/typedi) (class-field pattern — see [`CLAUDE.md`](./CLAUDE.md))
- **Testing**: `bun test` with per-test transactional rollback for repository tests

## Integrations

Out of the box, Scani knows how to talk to:

**Exchanges**: Binance, Kraken, Bybit, OKX, Coinbase, KuCoin, Gate.io,
HTX, Bitfinex, Bitstamp, Crypto.com, Gemini, MEXC, BitMart, Phemex, ProBit

**Brokerages / banks**: Interactive Brokers (Flex Web Service), Wise

**On-chain**: Ethereum + every EVM chain Etherscan V2 supports
(Polygon, Arbitrum, Optimism, Base, …), Solana (via Helius), Bitcoin,
Tron, TON, ENS

**Pricing**: CoinGecko, Finnhub, DeFiLlama, ExchangeRate-API, Yahoo
Finance, Google Sheets (for manual-asset prices)

**AI**: OpenAI (screenshot parsing), Perplexity, DeepSeek

Every provider has a directory under
[`packages/clients/providers/src/providers/`](./packages/clients/providers/src/providers/)
with a typed adapter behind a capability interface. **Adding a new
provider is one of the highest-leverage contributions** — see
[`CONTRIBUTING.md`](./CONTRIBUTING.md).

## Contributing

Pull requests welcome — start with
[`CONTRIBUTING.md`](./CONTRIBUTING.md), then read
[`CLAUDE.md`](./CLAUDE.md) for the engineering conventions.

Security findings should go to **security@scani.xyz**, not a public
issue. See [`.github/SECURITY.md`](./.github/SECURITY.md) for the full
disclosure flow.

## License

MIT. See [`LICENSE`](./LICENSE).

## Roadmap

Named things in flight:

- **Multi-arch Docker images** published to Docker Hub
  (`scani/api`, `scani/worker`, `scani/data-provider`, `scani/frontend-app`)
  via GitHub Actions, plus a `docker-compose.prod.yml` that pulls them.
- **OSS-native documentation site** — the repo intentionally keeps the
  README as the single source of truth for now; a dedicated docs site
  comes once we have something stable enough to deserve one.

Everything else lives in [GitHub issues](https://github.com/MGrin/scani-oss/issues).
