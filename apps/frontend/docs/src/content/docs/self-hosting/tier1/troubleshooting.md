---
title: Troubleshooting
description: The most common failures self-hosters hit and how to resolve them.
sidebar:
  order: 10
---

## Running two scani checkouts in parallel

**Symptom.** `bun run dev:stack` in a second worktree fails with
`Bind for 0.0.0.0:5433 failed: port is already allocated` (or one of
the other default host ports — 6380, 3011, 5173, 8082, 1026, 8026,
9000, 9001).

**Cause.** Both compose stacks bind the same host ports.

**Fix.** Every host-port mapping in `docker-compose.yml` is gated
behind a `*_HOST_PORT` env var with the default as fallback. Set the
overrides in the secondary worktree's root `.env` (a `+1000` offset
keeps the numbers easy to remember):

```ini
# Distinct compose project name so named volumes / networks don't collide
COMPOSE_PROJECT_NAME=scani-secondary

POSTGRES_HOST_PORT=6433
REDIS_HOST_PORT=7380
API_HOST_PORT=4011
FRONTEND_HOST_PORT=6173
DATA_PROVIDER_HOST_PORT=9082
MAILPIT_SMTP_HOST_PORT=2026
MAILPIT_UI_HOST_PORT=9026
MINIO_API_HOST_PORT=10000
MINIO_CONSOLE_HOST_PORT=10001
```

Then `bun run dev:stack` from each worktree independently. See
[`docker-compose.override.yml.example`](https://github.com/MGrin/scani-oss/blob/main/docker-compose.override.yml.example)
for the same recipe and an override template for harder
customizations (extra services, volume mounts, init SQL) that env vars
can't express.

## `docker compose up` fails with a container-name conflict

```
Error response from daemon: Conflict. The container name "/env-sync"
is already in use by container "..."
```

**Cause.** One-shot containers (`env-sync`, `deps`, `migrate`,
`minio-init`) exit cleanly but keep their names reserved.

**Fix.**

```sh
bun run dev:stack:down
# or, for prod compose:
docker compose -f docker-compose.prod.yml down
```

Then `up` again.

## Every sync fails silently after a server move

**Symptom.** The dashboard shows old balances. Logs show no errors
but no new transactions are written either. Manual sync triggers
appear to succeed.

**Cause.** `ENCRYPTION_KEY` on the new host does not match the
key the integration credentials were encrypted with. The decryption
fails silently per credential.

**Fix.** Restore the original `ENCRYPTION_KEY`. If it's lost, users
must re-enter their integration credentials. There is no recovery
path beyond that — this is by design (encrypted-at-rest credentials
are useless without the key).

## Magic-link emails never arrive

**Symptom.** Sign-in says "check your email"; nothing arrives.

**Cause 1.** No email transport configured. The data-provider
needs either `FASTMAIL_API_TOKEN` or `SMTP_URL` + `SMTP_FROM`.

**Cause 2.** Containerised stack has `FASTMAIL_API_TOKEN: ""`
hardcoded in `docker-compose.yml` to force SMTP fallback. If you set
a real Fastmail token in root `.env`, it's overridden in dev. To use
Fastmail in dev, comment out the override line.

**Cause 3.** Host-side `bun dev` reads `apps/backend/api/.env`,
which doesn't have SMTP config unless you added it. Add
`SMTP_URL=smtp://localhost:1026` + `SMTP_FROM=no-reply@scani.local`
to root `.env` and re-run `bun scripts/sync-env.ts`.

**Check.** In local dev, every email — including failed sends —
shows in [Mailpit at http://localhost:8026](http://localhost:8026).

## `/readyz` returns 503; worker loops on "Awaiting schema readiness"

**Symptom.** After a fresh `docker compose -f docker-compose.prod.yml
up -d`, the api is `(unhealthy)` and `frontend-app` won't start.
`curl http://localhost:8080/api/readyz` returns 503 with a body like
`{"checks":{"schema":{"ok":false,"error":"Schema not ready after
500ms — missing tables: user_jobs, tokens, holdings"}}}`. Worker logs
`⏳ Awaiting schema readiness before scheduler registration` in a
restart loop.

**Cause.** The schema hasn't been migrated. Prod compose intentionally
does NOT auto-migrate on `up -d` — the `migrate` service is
profile-gated so you (or your deploy pipeline) trigger it explicitly.

**Fix.**

```sh
docker compose -f docker-compose.prod.yml --profile migrate run --rm migrate
docker compose -f docker-compose.prod.yml restart api worker
```

After migrate exits with `✅ Migrations completed successfully`, the
api becomes healthy within ~30s and frontend-app comes up.

See [Apply migrations](/self-hosting/tier1/production/#apply-migrations)
for the full migration playbook.

## Worker silently drops jobs

**Symptom.** Jobs accepted by the api never run. BullMQ dashboard
shows nothing.

**Cause.** Worker process not running, or `REDIS_URL` mismatch
between api and worker.

**Fix.**

```sh
docker compose -f docker-compose.prod.yml ps worker
docker compose -f docker-compose.prod.yml logs worker | tail -50
```

Confirm `REDIS_URL` is identical:

```sh
docker compose -f docker-compose.prod.yml exec api env | grep REDIS_URL
docker compose -f docker-compose.prod.yml exec worker env | grep REDIS_URL
```

## "PRECONDITION_FAILED: <FOO>_API_KEY is not configured"

**Symptom.** A tRPC call returns this error.

**Cause.** The integration the call needs requires a provider key
the data-provider doesn't have. The named env var is missing.

**Fix.** Set the variable in `.env`, restart the data-provider:

```sh
docker compose -f docker-compose.prod.yml restart data-provider
```

See [Optional integration keys](/self-hosting/tier1/optional-keys/).

## Frontend SPA shows a blank page

**Symptom.** `/` loads but renders nothing. Network tab shows
`/api/...` calls failing with CORS or `401`.

**Cause 1.** `FRONTEND_URL` doesn't match the URL the browser is
actually using. CORS rejects every request.

**Fix.** Set `FRONTEND_URL` to the *exact* origin the browser sees,
including scheme. Recreate the api container.

**Cause 2.** Split-origin layout with no `COOKIE_DOMAIN`. The
session cookie set by the api doesn't reach the SPA's origin.

**Fix.** Set `COOKIE_DOMAIN=.your-domain.example.com`, restart api.

## Postgres connection-pool exhaustion

**Symptom.** Logs show `Error: sorry, too many clients already` or
`unable to acquire connection`.

**Cause.** Default `POSTGRES_POOL_MAX=20` is per-app. With api +
worker + data-provider all using the same pool size, you can exceed
your Postgres provider's connection limit (especially common on
serverless Postgres + PgBouncer).

**Fix.** Set `POSTGRES_POOL_MAX=5` (or lower) when using a
connection pooler. The api logs a loud warning at boot when it
detects a pooled URL with the default pool size.

## `frontend-app` can't reach `api` over the compose network

**Symptom.** `502 Bad Gateway` from nginx in `frontend-app`.

**Cause.** `API_UPSTREAM` env on `frontend-app` points at a name
nginx can't resolve. Default `http://api:3001` works on the compose
network; doesn't work outside it.

**Fix.** If running `frontend-app` standalone, set
`API_UPSTREAM=http://<api-host>:3001` explicitly.

## Migrations refuse to run

**Symptom.** `migrate` container exits with `relation already
exists` or similar.

**Cause.** Database state ahead of the migration set the code
expects. Typical after rolling back to an older image without
rolling Postgres back too.

**Fix.** Either roll Postgres back from your backup, or look at the
Drizzle `__drizzle_migrations` table to identify what's been
applied:

```sh
docker compose exec postgres psql -U scani scani \
  -c "select * from __drizzle_migrations order by created_at desc limit 10"
```

If you intentionally want to ignore a migration that's already
been applied, mark it as applied:

```sql
INSERT INTO __drizzle_migrations (hash, created_at)
VALUES ('<hash-from-meta/_journal.json>', extract(epoch from now()) * 1000);
```

Be careful — this is a foot-gun.

## MinIO bucket is empty after `down -v`

**Cause.** `down -v` wipes named volumes. Screenshot blobs and
file imports are gone.

**Fix.** This is expected. Use a managed S3 provider in production
so your bucket isn't tied to a local volume; or back the
`minio-data` volume up before `down -v`.

## See also

- [Production with docker-compose](/self-hosting/tier1/production/)
- [Backup & restore](/self-hosting/tier1/backup-restore/)
- [Observability](/self-hosting/tier1/observability/)
- [Required environment variables](/self-hosting/tier1/required-env/)
