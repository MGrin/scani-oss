---
title: Managed Postgres / Redis / S3
description: When you outgrow the in-compose data plane, point at managed services. Provider-by-provider env-var changes — no code changes.
sidebar:
  order: 6
---

The in-compose Postgres / Redis / MinIO are fine for a one-box deploy
or a small operator. When you outgrow them (or want managed backups,
HA failover, regional replication), Scani makes no assumption about
where its dependencies live. Comment out the compose service and
update the corresponding env vars.

## Postgres

Any **Postgres 16+** instance. The schema works with any vanilla
distribution.

| Provider | Notes |
|---|---|
| [Neon](https://neon.tech/) | Serverless. Set `?sslmode=require` and `POSTGRES_POOL_MAX=5` if the URL includes `?pgbouncer=true` (Neon's default endpoint pools through PgBouncer). |
| [Render](https://render.com/docs/databases) | Standard. `?sslmode=require`. |
| AWS RDS / Aurora | Standard. `?sslmode=require`. |
| [Supabase](https://supabase.com/) | Use the **direct** connection string for migrations, the pooled one for runtime (or set `POSTGRES_POOL_MAX=5`). |
| Self-hosted | Anything Postgres 16+. |

```ini
DATABASE_URL=postgres://user:pass@host:5432/scani?sslmode=require
POSTGRES_POOL_MAX=5   # only if behind a connection pooler
```

Then comment out the `postgres` service in `docker-compose.prod.yml`:

```yaml
# services:
#   postgres:
#     image: postgres:16-alpine
#     ...
```

### Migrations on a managed Postgres

The app containers run migrations on first boot — no separate step.
If you'd rather run them explicitly:

```sh
docker run --rm \
  -e DATABASE_URL="$DATABASE_URL" \
  oven/bun:1.3.13 \
  bash -c "git clone https://github.com/MGrin/scani-oss /app && \
           cd /app && bun install --frozen-lockfile && \
           bun run packages/infra/db/src/migrate.ts"
```

For repeated deployments, build a thin image with the migrate step
baked in.

## Redis

Any **Redis 7+** instance. Cluster mode is supported via standard
node-redis behaviour.

| Provider | Notes |
|---|---|
| [Upstash](https://upstash.com/) | TLS endpoint. `rediss://` URL. |
| [Redis Cloud](https://redis.com/) | TLS endpoint. |
| AWS ElastiCache | In-VPC. Standard `redis://` URL. |
| Self-hosted | Anything Redis 7+ with AOF persistence. |

```ini
REDIS_URL=rediss://default:pass@host:6379
```

Then comment out `redis` in `docker-compose.prod.yml`.

<aside>
  BullMQ requires Redis with **AOF persistence enabled**. The
  in-compose Redis runs with `--appendonly yes`; managed providers
  vary — verify with your provider before relying on it for
  delayed jobs to survive a restart.
</aside>

## S3-compatible storage

Any S3-compatible store works.

| Provider | Notes |
|---|---|
| [Cloudflare R2](https://www.cloudflare.com/products/r2/) | No egress fees. `S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com`. |
| AWS S3 | Region-specific endpoint. |
| [Backblaze B2](https://www.backblaze.com/cloud-storage) | `S3_ENDPOINT=https://s3.<region>.backblazeb2.com`. |
| MinIO (self-hosted, scaled out) | Same as compose-managed, just point at a remote instance. |

```ini
S3_ENDPOINT=https://<endpoint>
S3_PUBLIC_ENDPOINT=https://<public-endpoint>   # often same as above
S3_ACCESS_KEY_ID=<key>
S3_SECRET_ACCESS_KEY=<secret>
S3_BUCKET=scani-uploads
```

Then comment out `minio` and `minio-init`. **Create the bucket
yourself** before first boot — there's no init container for managed
providers.

## Email

| Provider | Variables |
|---|---|
| Any SMTP server | `SMTP_URL`, `SMTP_FROM`. |
| [Fastmail](https://www.fastmail.com/) | `FASTMAIL_API_TOKEN` (JMAP). Takes precedence over SMTP. |
| Postmark / SendGrid / Mailgun | Use their SMTP relay or set up a transactional API. SMTP is the simplest path. |

The `data-provider` is the only service that sends email. In Tier 1
that's your container; in Tier 2/3 the hosted data-provider handles
it (the user-side `.env` doesn't need email config).

## Object storage public endpoint quirk

`S3_PUBLIC_ENDPOINT` is what gets baked into presigned URLs the
browser uses. For compose-managed MinIO, `S3_ENDPOINT` is
`http://minio:9000` (server-to-server) and `S3_PUBLIC_ENDPOINT` is
`http://localhost:9000` (the browser can't resolve `minio`). For
most cloud providers both URLs are the same.

## Code does not change

No code change is required to use any of these. The schema doesn't
care. The application doesn't care. The compose file is just one
opinionated way to wire things together.

## See also

- [Production with docker-compose](/self-hosting/tier1/production/)
- [Required environment variables](/self-hosting/tier1/required-env/)
- [Backup & restore](/self-hosting/tier1/backup-restore/)
