---
title: Quickstart
description: Boot the full Scani stack locally in one command.
---

You need [Bun](https://bun.sh) ≥ 1.3 and Docker (Docker Desktop, OrbStack, or
any compatible runtime).

```bash
git clone git@github.com:MGrin/scani-oss.git
cd scani-oss
cp .env.example .env
bun install
bun run dev:stack        # boots Postgres, Redis, MinIO, Mailpit, api, worker, data-provider, frontend
open http://localhost:5173
```

The stack is self-contained — no external service credentials required. Auth,
holdings, FX pricing, and local screenshot storage (via MinIO) all work
without any API key. Provider API keys (CoinGecko, OpenAI, exchange
read-only keys, …) unlock specific integrations — see
[Environment variables](/scani-oss/self-hosting/environment/).

## Local ports

`docker-compose.yml` uses non-default host ports to avoid clashes:

| Service          | Host port               | Notes                                    |
| ---------------- | ----------------------- | ---------------------------------------- |
| Postgres         | `localhost:5433`        | `postgres` container                     |
| Redis            | `localhost:6380`        | `redis` container                        |
| Mailpit SMTP     | `localhost:1026`        | Submit mail here                         |
| Mailpit UI       | `http://localhost:8026` | Inspect dev emails                       |
| MinIO (S3)       | `localhost:9000`        | Local S3-compatible store                |
| MinIO console    | `http://localhost:9001` | `minioadmin` / `minioadmin`              |
| data-provider    | `localhost:8082`        | Tier-1 sidecar (incl. email.send tRPC)   |
| api              | `localhost:3001`        | Elysia tRPC API                          |
| frontend/app     | `http://localhost:5173` | Main SPA                                 |

## Stopping the stack

```bash
bun run dev:stack:down   # containers down, volumes preserved
```

## Email in dev

All auth emails (magic-link, OTP, verification) land in Mailpit at
[`http://localhost:8026`](http://localhost:8026). The flow:

```
api → email.send tRPC → data-provider → SMTP → mailpit:1025
```

The `data-provider` service hardcodes `FASTMAIL_API_TOKEN: ""` in compose to
force SMTP even when your shell or root `.env` has a real Fastmail token.
To test Fastmail in dev, comment out that line in `docker-compose.yml`.

## Gotchas

- **One-shot containers linger after clean exit.** `env-sync`, `deps`,
  `migrate`, and `minio-init` all use `restart: "no"` and keep their names
  reserved after exiting. `bun dev:stack:down` removes them; `compose up`
  without a prior `down` will hit a name-conflict error.
- **Host-side `bun dev` needs SMTP in root `.env`.** The containerized stack
  overrides `SMTP_URL` via compose environment; host-side api reads
  `apps/backend/api/.env` (generated from root `.env` by
  `scripts/sync-env.ts`), which has no SMTP config unless you add it to
  the root `.env` first.

## Next steps

- Configure provider keys → [Environment variables](/scani-oss/self-hosting/environment/)
- Deploy to a server → [Production](/scani-oss/self-hosting/production/)
- Understand what's running → [Architecture](/scani-oss/concepts/architecture/)
