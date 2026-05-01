# Self-hosting Scani

Scani ships as a Docker Compose stack. Everything you need to run it on your
own box is in this repo.

## Prerequisites

- Docker 24+ with the Compose plugin (`docker compose`)
- ~500 MB RAM for the full stack (Postgres + Redis + backend + worker + Mailpit)
- A publicly reachable hostname (only if you want SMTP-backed email verification
  to work from external providers — optional for single-user setups)

## Quick start

```bash
git clone https://github.com/MGrin/scani.git
cd scani
cp .env.example .env
# Edit .env: generate ENCRYPTION_KEY and BETTER_AUTH_SECRET (32+ chars each).
docker compose --profile full up -d --build
```

Services will come up in this order:

1. `postgres`, `redis`, `mailpit` (wait for healthcheck)
2. `migrate` — runs `bun run db:migrate` against an empty database; creates
   the 21 tables + seeds type enums, fiat tokens, institutions, and EVM chains.
3. `backend` — Elysia HTTP server on `localhost:3001`
4. `worker` — BullMQ consumer registering 4 repeatable jobs

Hit `http://localhost:3001/health/db` to confirm the backend is talking to the
database. Then sign up at `http://localhost:3001/api/auth/sign-up/email`.

## Configuration

The stack reads config from `.env`. The important variables:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string (required) |
| `REDIS_URL` | Redis connection string (required for BullMQ + state_backend=redis) |
| `ENCRYPTION_KEY` | AES-256 key for integration credentials (32+ chars) |
| `BETTER_AUTH_SECRET` | Session cookie signing (32+ chars) |
| `SMTP_URL` | SMTP URL for email verification |
| `FRONTEND_URL` | Frontend origin (CORS + Better-Auth cookie scope) |
| `SCANI_CLOUD_URL` | Data-provider endpoint — self-hosted container in Tier 1, `https://api.cloud.scani.xyz` in Tier 2/3 |
| `SCANI_CLOUD_API_KEY` | Bearer token backend/worker use to authenticate against the data-provider |
| `USE_BULLMQ` | `true` for containerized worker; `false` to run everything in one process |
| `STATE_BACKEND` | `redis` (recommended for self-host) or `memory` |

Reference all variables in `.env.example`.

## Tier 2 — cloud-assisted self-host

By default Tier 1 self-hosts its own `data-provider` container and you bring
your own provider API keys (CoinGecko, Finnhub, Etherscan, OpenAI, …) for
that container to use. If you'd rather have Scani's hosted data-provider
answer those calls for you — no provider API keys on your machine, billed
per request — point the backend and worker at `cloud.scani.xyz`:

```
SCANI_CLOUD_URL=https://api.cloud.scani.xyz
SCANI_CLOUD_API_KEY=<token from https://cloud.scani.xyz/keys>
```

Your Tier 2 stack now runs just the backend + worker (and Postgres +
Redis). Don't deploy the `data-provider` container; it would sit idle.

### Boot-time health probe

When `SCANI_CLOUD_URL` is set, both the backend and the worker call
`<url>/health` (3 attempts, 3 s timeout each) before they accept any
traffic. If the data-provider is unreachable they exit non-zero with a
descriptive message instead of letting every user request 5xx. Common
causes for a probe failure:

- Typo'd `SCANI_CLOUD_URL` — must be the full https URL, no trailing slash.
- Network egress blocked from your container — open outbound 443 to
  `api.cloud.scani.xyz`.
- The Tier 2/3 service is down — check
  [status.scani.xyz](https://status.scani.xyz) before chasing your config.

### Local-fallback (dev only)

When **both** env vars are unset, backend + worker fall back to
in-process providers using whatever keys are present in the env
(`OPENAI_API_KEY`, `R2_*`, `ETHERSCAN_API_KEY`, …). This is intended
only for contributors running the backend without booting the
`data-provider` sidecar. Production deployments must set
`SCANI_CLOUD_URL` (validated at boot in
`apps/backend/src/config/env.ts` + `apps/worker/src/config/env.ts`).

## Local development without Docker

If you'd rather run the backend in `bun dev` mode and only use Docker for
infra:

```bash
docker compose up -d postgres redis mailpit minio  # no --profile flag
bun install
bun run db:migrate
bun run dev
```

Auth emails land in Mailpit at `http://localhost:8026`. Ensure the root
`.env` has `SMTP_URL=smtp://localhost:1026` and
`SMTP_FROM=no-reply@scani.local` before running `bun dev`, then re-run
`bun scripts/sync-env.ts` so `apps/backend/.env` picks up the values.

## Updates

```bash
git pull
docker compose --profile full up -d --build
```

Migrations run automatically on the next `up`.

## Backups

`pg_dump` against the `postgres` service:

```bash
docker compose exec postgres pg_dump -U scani scani > scani-backup.sql
```

## Troubleshooting

**Migrations fail with "relation already exists":** your local DB has data
from an earlier schema. Drop and rebuild the `postgres-data` volume:
`docker compose down -v postgres`.

**Better-Auth signup returns `FAILED_TO_CREATE_USER`:** `users.id` must be
UUID-generated. If you've customized `advanced.database.generateId`, it must
return a valid UUID v4.

**BullMQ jobs are queued but never processed:** the `worker` service isn't
running. Check `docker compose logs worker`.

## Need help?

Open an issue on GitHub.
