---
title: Troubleshooting
description: The most common failures self-hosters hit and how to resolve them.
sidebar:
  order: 10
---

## A failed install cannot be re-run

**Symptom.** `scripts/self-host.sh` stops with:

```
a previous install's data is still on this machine, and the secrets that
unlock it are not.
```

Or, on any version before this check existed, the migration step dies with:

```
G1: password authentication failed for user "scani"
 severity: FATAL   code: 28P01   routine: auth_failed
```

**Cause.** A first run got far enough to start Postgres — which initialised
its volume with that run's generated password — and then failed. Any ordinary
hiccup does it: a host port already taken, a Ctrl-C, a dropped image pull, a
laptop going to sleep. The `.env` holding that password is then deleted or
never kept, and Compose names its volumes after the **project**, which comes
from the directory's name and not from anything inside it. So deleting the
install directory removes the secrets and leaves the database, and a fresh
install into a directory of the same name meets a Postgres that wants a
password nobody has any more.

**Fix.** Two, and the script prints both with your project's names in them:

- **Keep the data.** Put that run's `.env` back next to the compose file and
  run the script again. Nothing is regenerated and the install converges —
  this is the ordinary recovery, and it works from any partly-failed run as
  long as the `.env` survived.
- **Throw the data away.** Re-run with `SCANI_RESET=1`, which deletes this
  project's containers and its `postgres-data`, `redis-data` and `minio-data`
  volumes before installing. By hand, the same thing:

  ```sh
  docker rm -f $(docker ps -aq --filter label=com.docker.compose.project=<project>)
  docker volume rm <project>_postgres-data <project>_redis-data <project>_minio-data
  ```

`<project>` is the install directory's name unless you set
`COMPOSE_PROJECT_NAME`. `docker volume ls` will show them.

## Running two scani checkouts in parallel

`bun run dev:stack` already gives each checkout a stack of its own. It
derives a compose project name and one host port per service from the
checkout's own path, so the containers, volumes and images of one
checkout are never another's, and `bun run dev:stack:down` can only
tear down the stack it started. The repository's main working tree
keeps the documented ports above; a linked `git worktree` gets a slot
of its own. `bun scripts/dev-stack.ts env` prints the variables yours
will use, and `dev:stack` prints where the stack is reachable once it
is up.

**Symptom.** `bun run dev:stack` in a second checkout still fails with
`Bind for 0.0.0.0:5433 failed: port is already allocated` (or one of
the other host ports).

**Cause.** There are twenty offset slots, so two checkouts can draw the
same one. This is the loud half of the problem, and the only half left.

**Fix.** Move *your* stack with a `*_HOST_PORT` override:

```sh
POSTGRES_HOST_PORT=7333 bun run dev:stack
```

Do not stop the other checkout's containers instead. That frees the
port and leaves anything pointed at that stack with nothing to reach —
a twenty-minute diagnosis in place of a one-line fix. The override
moves the published port and every URL that names it together, and a
value that is not a TCP port is refused rather than quietly replaced by
the derived one.

Put it in that checkout's root `.env` to make it stick. See
[`docker-compose.override.yml.example`](https://github.com/MGrin/scani-oss/blob/main/docker-compose.override.yml.example)
for an override template for harder customizations (extra services,
volume mounts, init SQL) that env vars can't express.

**A bare `docker compose up` does none of this.** With no project name
compose falls back to the directory's, which is the same in every
checkout — so a second `up` does not conflict with the first, it
**adopts and recreates its containers**, including a Postgres somebody
is using. If you must drive compose by hand, export the variables
first:

```sh
export $(bun scripts/dev-stack.ts env | xargs)
```

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

**Cause.** Worker process not running, or `DATABASE_URL` mismatch
between api and worker — the queue lives in the `bullmq` schema of
that database, so pointing the two at different databases means the
api enqueues where the worker is not looking.

**Fix.**

```sh
docker compose -f docker-compose.prod.yml ps worker
docker compose -f docker-compose.prod.yml logs worker | tail -50
```

Confirm `DATABASE_URL` is identical:

```sh
docker compose -f docker-compose.prod.yml exec api env | grep DATABASE_URL
docker compose -f docker-compose.prod.yml exec worker env | grep DATABASE_URL
```

If the worker logs `schema "bullmq" is not initialized`, the queue
schema was never applied — run the `migrate` image (see
[Apply migrations](/self-hosting/tier1/production/#apply-migrations)).

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

**Fix.** Either roll Postgres back from your backup, or look at
`drizzle.__scani_migrations` to see what's been applied — one row
per migration, named by its filename:

```sh
docker compose exec postgres psql -U scani scani \
  -c "select tag, applied_at from drizzle.__scani_migrations order by tag desc limit 10"
```

If the effects are already present and nothing is recorded — a
database restored from a dump — name the last migration the dump
contains and the runner adopts everything up to it without running
any of them:

```sh
docker compose --profile migrate run --rm migrate \
  /app/migrate --allow-remote postgres \
  --assume-applied-through <filename without .sql>
```

Be careful: that asserts something the runner cannot verify. Don't
hand-write rows into `drizzle.__scani_migrations` instead — the
`sha256` column is what detects an applied migration being edited,
and a made-up value turns the next deploy into a refusal.

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
