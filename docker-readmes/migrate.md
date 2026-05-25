<!-- description: Scani schema migrator. One-shot image that applies Drizzle migrations. github.com/MGrin/scani-oss -->

# scani/migrate

Drizzle migration runner for **[Scani](https://github.com/MGrin/scani-oss)** —
the self-hostable, open-source portfolio tracker for crypto and traditional
assets.

A one-shot container that applies pending schema migrations against your
Postgres and exits. Migrations live OUTSIDE the
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
  scani/migrate:latest
```

Successful output:

```
🔄 Starting database migrations...
📍 PostgreSQL connection (ssl=require)
📂 Migrations folder: /app/packages/infra/db/src/migrations
✅ Migrations completed successfully
```

Exit code is `0` on success, `1` on any failure.

## Required environment variables

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres 16+ connection string. SSL mode is auto-detected from the URL (`?sslmode=disable` for local, `require` for hosted). |

That's the only variable the migrator reads. It does NOT need the
`ENCRYPTION_KEY`, `BETTER_AUTH_SECRET`, or any other app-level secret.

## What's inside

- `bun` runtime (slim)
- `drizzle-orm` + `postgres.js` (the only runtime deps)
- The migration runner from
  [`packages/infra/db/src/migrate.ts`](https://github.com/MGrin/scani-oss/blob/main/packages/infra/db/src/migrate.ts)
- All SQL migration files from
  [`packages/infra/db/src/migrations/`](https://github.com/MGrin/scani-oss/tree/main/packages/infra/db/src/migrations)

Image size is ~100 MB compressed. The container exits as soon as
migrations complete; nothing long-running.

## Source

Full source, architecture, and contribution guidelines:
**https://github.com/MGrin/scani-oss**

MIT licensed.
