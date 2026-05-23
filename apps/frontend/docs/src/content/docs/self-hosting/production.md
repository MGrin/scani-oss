---
title: Production
description: Deploying Scani against managed Postgres, Redis, and S3-compatible storage.
---

The repo ships a
[`docker-compose.prod.yml`](https://github.com/MGrin/scani-oss/blob/main/docker-compose.prod.yml)
that pulls pre-built multi-arch images from Docker Hub
(`scani/api`, `scani/worker`, `scani/data-provider`, `scani/frontend-app`)
and wires them up with Postgres + Redis + MinIO.

## One-command bring-up

```bash
cp .env.example .env                              # set real values
docker compose -f docker-compose.prod.yml up -d
```

## Required env values for production

Set these in `.env` before bringing the stack up:

- `BACKEND_URL` / `FRONTEND_URL` — public URLs the browser will see
- `BETTER_AUTH_SECRET` — 32+ chars; do not reuse the dev value
- `ENCRYPTION_KEY` — 32 hex chars; same on api and worker
- `JOBS_HMAC_SECRET` — shared secret for HMAC-gated job admin endpoints
- `DATA_PROVIDER_API_KEY` / `SCANI_CLOUD_API_KEY` — bearer for the
  data-provider hop
- `LOG_ID_PEPPER` — pepper for log-id hashing

Put your own TLS-terminating reverse proxy in front of the `frontend-app`
container — it's the only one that needs to be reachable from the public
internet. The nginx baked into the frontend image proxies `/api` and `/ws`
to the `api` container over the compose network.

## Using managed Postgres / Redis / S3

Comment out the corresponding services in `docker-compose.prod.yml` and
point `DATABASE_URL` / `REDIS_URL` / `S3_*` at the managed endpoints. The
app code makes no assumption about whether the dependency is in-compose or
elsewhere.

Provider choice for each layer is up to the operator:

- **Postgres** — any 16+ instance (Neon, Render, RDS, self-hosted, …).
- **Redis** — any 7+ instance (Upstash, Redis Cloud, self-hosted, …).
- **Object storage** — any S3-compatible store (MinIO locally, Cloudflare R2,
  AWS S3, Backblaze B2, …).
- **Email** — SMTP or Fastmail JMAP via `FASTMAIL_API_TOKEN`.
- **Auth** — Better-Auth (no external auth provider required).

## Image tags

Images are tagged:

- `:latest` — head of `main`
- `:sha-<short>` — every push
- `:1.2.3` / `:1.2` / `:1` — semver tags

Pin `SCANI_IMAGE_TAG=1.2.3` in `.env` if you want reproducible deploys.
