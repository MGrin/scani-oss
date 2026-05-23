<!-- description: Scani tRPC + Elysia API server. Self-hostable portfolio tracker. github.com/MGrin/scani-oss -->

# scani/api

tRPC + Elysia HTTP server for **[Scani](https://github.com/MGrin/scani-oss)** — the
self-hostable, open-source portfolio tracker for crypto and traditional assets.

Owns per-user credentialed integrations (exchange API keys, brokerage tokens) so
user credentials never cross the tenant boundary. Enqueues async work onto Redis
(BullMQ) for [`scani/worker`](https://hub.docker.com/r/scani/worker) to consume.

## Tags

- `latest` — head of `main`
- `sha-<short>` — every push to `main`
- `1.2.3` / `1.2` / `1` — semver release tags

Pin `SCANI_IMAGE_TAG=1.2.3` in your `.env` for reproducible deploys.

## Quick start

The recommended way to run this image is via the reference
[`docker-compose.prod.yml`](https://github.com/MGrin/scani-oss/blob/main/docker-compose.prod.yml)
in the OSS repo — it wires this image up with Postgres, Redis, MinIO,
[`scani/worker`](https://hub.docker.com/r/scani/worker),
[`scani/data-provider`](https://hub.docker.com/r/scani/data-provider), and
[`scani/frontend-app`](https://hub.docker.com/r/scani/frontend-app):

```bash
git clone https://github.com/MGrin/scani-oss.git
cd scani-oss
cp .env.example .env                              # set real values
docker compose -f docker-compose.prod.yml up -d
```

## Required environment variables

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres 16+ connection string |
| `REDIS_URL` | Redis 7+ connection string |
| `BETTER_AUTH_SECRET` | 32+ chars; signs sessions |
| `ENCRYPTION_KEY` | 32 hex chars; **must match** `scani/worker` |
| `JOBS_HMAC_SECRET` | Shared secret for HMAC-gated job admin endpoints |
| `FRONTEND_URL` / `BACKEND_URL` | What the browser sees; powers CORS + cookies |
| `S3_*` | Object storage (any S3-compatible store) |
| `SCANI_CLOUD_URL` / `SCANI_CLOUD_API_KEY` | Where `scani/data-provider` lives + bearer to reach it |

Full annotated list: [`.env.example`](https://github.com/MGrin/scani-oss/blob/main/.env.example).

## Source

Full source, architecture, and contribution guidelines:
**https://github.com/MGrin/scani-oss**

MIT licensed.
