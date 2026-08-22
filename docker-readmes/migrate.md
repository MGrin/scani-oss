<!-- description: Scani schema migrator. Applies the app and queue schemas. github.com/MGrin/scani-oss -->

# scani/migrate

Schema migration runner for **[Scani](https://github.com/MGrin/scani-oss)** —
the self-hostable, open-source portfolio tracker for crypto and traditional
assets.

A one-shot container that applies pending schema migrations against your
Postgres and exits. It applies **both** schemas Scani needs: the application
tables (Drizzle) and the job-queue schema (BullMQ). Run it before the first
boot — the api and worker do not create either one, so an unmigrated database
returns `schema "bullmq" is not initialized` on the first background job. Migrations live OUTSIDE the
[`scani/api`](https://hub.docker.com/r/scani/api),
[`scani/worker`](https://hub.docker.com/r/scani/worker), and
[`scani/data-provider`](https://hub.docker.com/r/scani/data-provider) runtime
images by design — schema changes are an operator concern, not something
the app silently does on its own.

## Tags

- `latest` — highest semver release tag
- `1.2.3` / `1.2` / `1` — semver release tags

**Always use the same tag you're upgrading your app images to.** Mixing
e.g. `scani/migrate:1.2.0` with `scani/api:1.3.0` is unsupported.

## Quick start

The recommended way to run this image is via the reference
[`docker-compose.prod.yml`](https://github.com/MGrin/scani-oss/blob/main/docker-compose.prod.yml),
which exposes it as a profile-gated one-shot service:

```bash
# Step 1 — apply migrations
docker compose -f docker-compose.prod.yml --profile migrate run --rm migrate

# Step 2 — bring the rest of the stack up
docker compose -f docker-compose.prod.yml up -d
```

Re-run step 1 on every upgrade (after `docker compose pull`) before
restarting the long-running services. The migrator is idempotent —
already-applied migrations are skipped.

### Standalone usage

For Kubernetes Jobs, CI deploy steps, or any orchestrator that isn't
docker-compose:

```bash
docker run --rm \
  -e DATABASE_URL='postgres://user:pass@your-postgres-host:5432/scani?sslmode=require' \
  scani/migrate:latest /app/migrate --allow-remote your-postgres-host
```

`--allow-remote <host>` is required for any database that is not on
loopback, and the host you name has to match the one in `DATABASE_URL`.
That is deliberate: it is the one guard against a stale connection string
rewriting the wrong database unnoticed. Without it the container refuses
and exits `1` having changed nothing.

Successful output:

```
🎯 Target: postgres://your-postgres-host:5432/scani
🔓 Non-local target named on the command line (--allow-remote your-postgres-host)
🔄 Starting database migrations...
📍 PostgreSQL connection (ssl=require)
📂 Migrations folder: /app/migrations
✅ Migrations completed successfully — 63 applied, 0 already present
📦 BullMQ schema migrated | schema=bullmq
migrate: application + queue schemas applied
```

Exit code is `0` on success, `1` on any failure. A failing application
migration stops before the queue schema is touched.

## Required environment variables

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres 16+ connection string. SSL mode is auto-detected from the URL (`?sslmode=disable` for local, `require` for hosted). |

That's the only variable the migrator reads. It does NOT need the
`ENCRYPTION_KEY`, `BETTER_AUTH_SECRET`, or any other app-level secret.

## What's inside

- A single self-contained binary (`bun build --compile`) on
  `debian:bookworm-slim` — no `bun` runtime and no `node_modules` tree
- The migration runner from
  [`scripts/migrate.ts`](https://github.com/MGrin/scani-oss/blob/main/scripts/migrate.ts),
  the same entrypoint `bun run db:migrate` uses from source
- All SQL migration files from
  [`packages/infra/db/src/migrations/`](https://github.com/MGrin/scani-oss/tree/main/packages/infra/db/src/migrations)
- BullMQ's own schema SQL, which its migrator reads from disk at runtime

Image size is well under 100 MB. The container exits as soon as
migrations complete; nothing long-running.

## Source

Full source, architecture, and contribution guidelines:
**https://github.com/MGrin/scani-oss**

MIT licensed.
