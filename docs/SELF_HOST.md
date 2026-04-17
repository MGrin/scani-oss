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
3. `backend` — Elysia HTTP server on `localhost:3002`
4. `worker` — BullMQ consumer registering 4 repeatable jobs

Hit `http://localhost:3002/health/db` to confirm the backend is talking to the
database. Then sign up at `http://localhost:3002/api/auth/sign-up/email`.

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
| `EXTERNAL_API_MODE` | `direct` (your own API keys) or `scani-cloud` (Tier 2) |
| `AUTH_PROVIDER` | `better-auth` for self-host; `supabase` for legacy |
| `USE_BULLMQ` | `true` for containerized worker; `false` to run everything in one process |
| `STATE_BACKEND` | `redis` (recommended for self-host) or `memory` |

Reference all variables in `.env.example`.

## Tier 2 — cloud-assisted self-host

By default you bring your own API keys for CoinGecko, Finnhub, Etherscan, etc.
If you'd rather have Scani's cloud service proxy those calls on your behalf
(so you don't pay for upstream API plans), set:

```
EXTERNAL_API_MODE=scani-cloud
SCANI_CLOUD_API_URL=https://cloud.scani.xyz
SCANI_CLOUD_CLIENT_TOKEN=<token from https://scani.xyz/cloud/signup>
```

*Tier 2 is not live yet.* This seam is landed so it'll drop in when the cloud
service ships.

## Local development without Docker

If you'd rather run the backend in `bun dev` mode and only use Docker for
infra:

```bash
docker compose up -d postgres redis mailpit  # no --profile flag
bun install
bun run db:migrate
bun run dev
```

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
