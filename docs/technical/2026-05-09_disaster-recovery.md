# Disaster Recovery Runbook

This is the cold-start guide for the four production-bearing surfaces:

1. **Postgres (Neon)** — primary durable store.
2. **Redis (embedded in the scani-worker Fly machine)** — BullMQ +
   rate-limiter + WebSocket pub/sub. AOF-persisted on the `redis_data`
   volume; 6PN-only.
3. **Object storage (Cloudflare R2)** — file uploads + DB backups.
4. **Secrets** — rotation when a credential is suspected leaked.

Every runbook step references the actual workflow / file / command. If
you change any of them, update this doc.

The companion automation is `.github/workflows/restore-test.yaml`, which
runs the Postgres restore on the first of each month against an
ephemeral Neon branch and fails the workflow if the restored schema
shape doesn't match expectations. **A backup that has never been
restored is half a backup.**

---

## 1. Postgres restore (Neon)

### Source of truth

- Live DB: Neon project `scani` (managed via Terraform under
  `infra/terraform/neon.tf`).
- Backup workflow: `.github/workflows/backup-db.yaml` runs Sundays at
  03:07 UTC, uploads `scani-<YYYYMMDD>T<HHMMSS>Z.dump` to the
  `scani-backups` R2 bucket via `pg_dump --format=custom`.
- Neon native: point-in-time recovery available within
  `history_retention_seconds` (currently 6 h on the free plan — see
  `infra/terraform/neon.tf:9`). Enough for "deploy at 02:00 → caught at
  07:00" but **not** for a Sunday-night incident discovered Monday
  morning. The R2 backup is the multi-day fallback.

### Step-by-step: restore from R2 backup into a fresh Neon branch

1. **Find the backup** to restore:
   ```bash
   aws --endpoint-url "$R2_S3_ENDPOINT" \
       s3 ls "s3://scani-backups/" \
     | sort | tail -n 5
   ```
   Pick the file *immediately before* the bad event.

2. **Pull it locally**:
   ```bash
   aws --endpoint-url "$R2_S3_ENDPOINT" \
       s3 cp "s3://scani-backups/scani-<TS>.dump" ./restore.dump
   ```

3. **Create an isolated Neon branch** (do not restore into prod
   directly):
   ```bash
   neonctl branches create --project-id <project> \
       --name "restore-<TS>" \
       --parent main
   neonctl connection-string --project-id <project> \
       --branch "restore-<TS>" --pooler false
   # use the unpooled URL for restore — pgbouncer chokes on multi-statement
   # COPY chunks pg_restore emits.
   ```
   Capture the URL as `RESTORE_URL`.

4. **Restore the dump** into that branch:
   ```bash
   pg_restore --no-owner --no-privileges --clean --if-exists \
       --dbname "$RESTORE_URL" ./restore.dump
   ```
   This drops + recreates every table. Roughly 30–90s for a healthy
   prod-sized DB; longer if there are large indexes.

5. **Smoke-test the restored schema**:
   ```bash
   psql "$RESTORE_URL" -c "\
     SELECT 'users' tbl, count(*) FROM users UNION ALL \
     SELECT 'holdings', count(*) FROM holdings UNION ALL \
     SELECT 'holding_transactions', count(*) FROM holding_transactions UNION ALL \
     SELECT 'cloud_api_keys', count(*) FROM cloud_api_keys;"
   ```
   Counts should match what you expect from the backup window. If any
   are zero, the restore was incomplete; do not proceed.

6. **Cut traffic over** (only after the smoke test passes). Two paths:
   - **In-place** (lossy — discards everything written to main since
     the backup): `neonctl branches set-default <restore-branch>`
     then redeploy api+worker+data-provider so they pick up the new
     branch's connection.
   - **Reconciled** (preferred when minutes of writes matter): keep
     prod live, run a per-table diff between `main` and `restore-<TS>`,
     pull the missing rows forward into main using `INSERT … ON
     CONFLICT DO NOTHING`. Slow and manual; the right call when the
     bad event was a single-table corruption (e.g. one botched
     migration) rather than a full DB compromise.

7. **Clean up**: once traffic has been cut over and the restored data
   is confirmed in production, delete the temporary branch:
   ```bash
   neonctl branches delete --project-id <project> "restore-<TS>"
   ```

### Step-by-step: Neon point-in-time recovery (within 6 h)

For incidents discovered fast enough to use Neon's native PITR:

1. `neonctl branches create --parent main --restore-point <ISO timestamp>`.
2. Repeat steps 4–7 above against the new branch.

PITR is faster (no `pg_restore` round-trip) and produces an exact
moment-of-time snapshot rather than the previous-Sunday-morning shape.
Always prefer it when the bad event is recent enough.

### Verifying restore-test workflow output

`restore-test.yaml` runs monthly. If it goes red:

- Open the workflow run, look at the `restore` job's logs.
- Most common failures: (a) backup file missing or truncated, (b)
  schema drift between the backup and the current Drizzle migrations,
  (c) Neon branch quota exhausted.
- Fix forward. Don't ignore a red restore-test for >7 days; that
  defeats the purpose.

---

## 2. Redis flush + rebuild (worker-embedded)

Redis stores **only volatile state**: BullMQ job queues, rate-limiter
counters, WebSocket pub/sub. None of it is the source of truth — every
queued job has a Postgres mirror row in `user_jobs`, every rate-limit
counter regenerates from traffic, and pub/sub messages are
opportunistic.

### When to flush

- Suspected pub/sub channel poisoning (clients getting bogus realtime
  events).
- BullMQ-internal corruption (rare; surfaces as `unknown job state`
  errors in worker logs).
- Cross-environment contamination (a dev process pointed at prod
  Redis — see `WORKER_CONCURRENCY_CRON` env-isolation guard, P1-7).

### Flush procedure

Redis runs *inside* the worker machine, so don't stop the machine — that
kills Redis too. Flush in place, then restart the machine for a clean
re-registration:

1. `flyctl ssh console -a scani-worker`, then inside the machine:
   `redis-cli -a "$(printf '%s' "$REDIS_URL" | sed -nE 's|^rediss?://[^:/@]*:([^@]*)@.*$|\1|p')" FLUSHALL`
   (the requirepass is embedded in `REDIS_URL`; same parse the
   entrypoint uses).
2. Restart the machine:
   `flyctl machine list -a scani-worker --json | jq -r '.[0].id' | xargs -I{} flyctl machine restart {} -a scani-worker`.
   redis-server comes back empty (the AOF now records the flush) and the
   worker re-registers every repeatable schedule via
   `JobScheduler.upsertAll()` at boot
   (`apps/backend/worker/src/index.ts`). User-job mirror rows in
   `user_jobs` will be picked up by `reconcile-orphaned-user-jobs` and
   marked `failed` so the user can retry from the UI.

### What you lose

- All in-flight jobs (queued or active). They become orphans in
  `user_jobs`; the reconciler marks them `failed` within 15 minutes
  (quarter-hour sweep cadence) and the user retries.
- DLQ history. Recent failures we hadn't yet acted on are gone — keep
  this in mind before flushing during an active incident.

---

## 3. R2 bucket recovery

### Buckets

| Bucket | Purpose | Loss tolerance |
|---|---|---|
| `scani-backups` | Weekly Postgres dumps. | High — re-run `backup-db.yaml` to refill. |
| `scani-job-uploads` | Per-user file uploads (CSV, OFX, screenshots). | **None.** User data; treat as primary. |
| `scani-tfstate` | Terraform state. | High — recreate from the live infra (slow but possible). |

### If `scani-job-uploads` is corrupted

R2 buckets enable [object versioning](https://developers.cloudflare.com/r2/buckets/object-versioning/)
when configured (verify in the Cloudflare dashboard). Each object
write keeps the prior version:

```bash
wrangler r2 object versions list scani-job-uploads --key <key>
wrangler r2 object get scani-job-uploads --key <key> \
    --version-id <version> > recovered.bin
```

If versioning is **not** enabled, recovery is best-effort: most uploads
are temp-prefixed (`temp/<purpose>/<userId>`) with a 24h R2-lifecycle
purge, and the persistent files are referenced directly by Postgres
rows that record the R2 key — so the source of truth for "what should
be there" is the DB, not the bucket. Re-uploading from the user is the
most common recovery path.

### If `scani-tfstate` is corrupted

`terraform.yaml` writes state on every apply. If the live state file
is unrecoverable:

1. Pull the most recent good copy from R2 versioning.
2. Or: `terraform import` every managed resource by hand, starting from
   `infra/terraform/main.tf`. Slow (45–90 min) but works.

---

## 4. Secret rotation

When a secret is suspected leaked, follow this order to minimize blast
radius. *Don't skip steps* — partial rotation creates auth-instability
windows where some replicas have the new key and others have the old.

### `DATA_PROVIDER_API_KEY` (data-provider superuser bearer)

This token never expires by default but **does** support an expiry
header (`DATA_PROVIDER_API_KEY_EXPIRES_AT`, ISO-8601 UTC). Use it to
roll without downtime:

1. Generate a new key: `openssl rand -hex 32`.
2. Add the *new* key to GitHub Actions secrets as
   `DATA_PROVIDER_API_KEY_NEXT`.
3. Stage the new value on data-provider, but keep the old as the
   active one with an expiry timestamp ~5 min in the future:
   ```bash
   flyctl secrets set --stage --app scani-data-provider \
     DATA_PROVIDER_API_KEY="$NEW_KEY" \
     DATA_PROVIDER_API_KEY_EXPIRES_AT="$(date -u -d '+5 min' --iso-8601=seconds)"
   ```
4. Update backend + worker `SCANI_CLOUD_API_KEY` to the new value:
   ```bash
   flyctl secrets set --app scani-backend SCANI_CLOUD_API_KEY="$NEW_KEY"
   flyctl secrets set --app scani-worker  SCANI_CLOUD_API_KEY="$NEW_KEY"
   ```
   This restarts both services with the new credential.
5. Once Sentry shows zero `auth.superuser` breadcrumbs from the old
   key (typically within seconds), redeploy data-provider to pick up
   the staged new value:
   ```bash
   flyctl deploy --app scani-data-provider --config apps/backend/data-provider/fly.toml
   ```

### `ENCRYPTION_KEY` (per-user credentials, AES-256-GCM)

Cannot be rotated in place — every encrypted credential blob is keyed
to the live `ENCRYPTION_KEY`. Procedure:

1. Pause user-initiated jobs: drain BullMQ queue (`flyctl machine stop`
   on the worker).
2. Run a one-shot migration script that decrypts every
   `user_integration_credentials.encrypted_credentials` with the OLD
   key and re-encrypts with the NEW key. This script does not exist
   yet — write it under `apps/backend/admin-scripts/rotate-encryption-key.ts`
   when needed (the cleartext schema is documented in
   `packages/infra/security/src/encryption.ts`).
3. Update the secret on api + worker simultaneously
   (`flyctl secrets set --app scani-backend --app scani-worker
   ENCRYPTION_KEY=$NEW`).
4. Restart worker.

### Better-Auth `BETTER_AUTH_SECRET`

Rotating invalidates every active session — every user signs out. Plan
for the comms.

The api app and the data-provider both consume Better-Auth — the api
for the main scani.xyz session, the data-provider for the
`cloud.scani.xyz` console (when `CLOUD_MANAGEMENT_ENABLED`). They use
**separate secrets** so rotating one doesn't sign out the other:

```bash
# Main app (scani.xyz)
flyctl secrets set --app scani-backend BETTER_AUTH_SECRET="$(openssl rand -hex 32)"

# Cloud console (cloud.scani.xyz) — only when CLOUD_MANAGEMENT_ENABLED
flyctl secrets set --app scani-data-provider BETTER_AUTH_SECRET="$(openssl rand -hex 32)"
```

### `ADMIN_SESSION_SECRET` (admin dashboard signed-cookie session)

Used by `apps/frontend/admin` to sign the passkey-authenticated session
cookie. Rotating signs every admin out of the dashboard but doesn't
affect customer auth.

The admin runs on Cloudflare Pages, so the secret lives in Pages env
vars (managed via Terraform under `infra/terraform/cloudflare.tf`):

1. Generate: `openssl rand -hex 32`.
2. Update GitHub Actions secret `ADMIN_SESSION_SECRET`.
3. `bun run terraform:apply` re-stages the value on the Pages project,
   triggering a redeploy with the new value.
4. Confirm: visit `https://admin.scani.xyz` in a fresh browser; the
   passkey gate should re-prompt.

### `ADMIN_JOBS_HMAC_SECRET` (admin → api action signing)

Shared between `apps/frontend/admin` (signs HMAC of admin → api
mutations like job retry / DLQ purge) and `apps/backend/api` (verifies
HMAC). Both must rotate atomically — a mismatched secret breaks the
admin job dashboard until both sides converge.

1. Generate: `openssl rand -hex 32`.
2. Update GitHub Actions secret `ADMIN_JOBS_HMAC_SECRET`.
3. **Stage on api first** so the backend tolerates either old or new
   during the transition (this requires the api to read both `_OLD`
   and `_NEW` fallback envs — currently the code does NOT, so accept
   ~30 s of admin-action failures during the swap):
   ```bash
   flyctl secrets set --app scani-backend ADMIN_JOBS_HMAC_SECRET="$NEW"
   ```
4. Trigger admin redeploy via `terraform apply`.

### Other vendor tokens (Sentry, Fly, R2, Etherscan, OpenAI, …)

Rotate via the vendor console first, then:
- Update GitHub Actions secret (Settings → Secrets and variables →
  Actions).
- Trigger redeploy of any app that consumes the secret. The deploy
  workflow re-stages secrets via `flyctl secrets set --stage` followed
  by `flyctl deploy`.

---

## 5. Connection-pool exhaustion

Symptom: api / worker / data-provider start logging
`PostgresError: too many connections for role "scani"` and 5xx spikes.

### Connection budget — what we expect

Per-app pool: `max=20` from `packages/infra/db/src/connection.ts:62`,
overridable via `POSTGRES_POOL_MAX`. Multiplied by Fly machine count:

| App | Machines | Budget |
|---|---|---|
| `scani-backend` (api) | 1 (single replica — WS state local) | 20 |
| `scani-worker` | 1 | 20 |
| `scani-data-provider` | 2 (rolling deploy needs 2) | 40 |
| **Total ceiling** | | **80** |

Neon free-plan ceiling per branch is ~100 with default settings. 80
leaves ~20 headroom for migrations, ad-hoc psql, and the monthly
`restore-test.yaml` worker that opens an isolated branch (it does
NOT count against the production branch).

If the org moves to Neon Pro the ceiling rises (currently 1000), but
this doc should be updated when that happens.

### Triage

1. Check Neon dashboard → connection count. If it's >80, we're past
   the budget — a leak is in flight.
2. The api app has a `endConnectionTracking` pair around request
   handling (after the 2026-05-08 OOM incident, see
   `apps/backend/api/fly.toml`). Greppable as
   `connection-monitor` in pino logs.
3. If a leak is confirmed, restart the leaking machine
   (`flyctl machine restart <id> -a <app>`). That clears every open
   connection from that replica.
4. File an incident note in `docs/archive/` once resolved with the
   commit that introduced the regression.

---

## 6. Deploy rollback

When a Fly deploy succeeds but the new code is broken in production
(e.g. a regression slipped past CI), roll back fast — every minute of
5xx is a refund or a churned customer. The procedure differs slightly
depending on whether the deploy ran a database migration.

### 6a. Rollback when no migration ran in this deploy

The deploy workflow at `.github/workflows/deploy-fly.yaml` runs DB
migrations BEFORE deploying app code. If the migration step was a
no-op (no files in `packages/infra/db/src/migrations/` changed), the
schema is identical to the previous deploy and rolling back is a
single command:

1. Find the previous good commit on `main`:
   ```bash
   git log --oneline main -10
   ```
2. Re-deploy from that commit. The workflow has a manual trigger
   (`workflow_dispatch`); pass the commit SHA as an input. No code
   changes needed — just click Re-run on the previous green deploy
   in the Actions UI.
3. Watch `https://app.scani.xyz/health`, the data-provider's
   `/health/r2`, and Sentry inbox; they should clear within minutes.

### 6b. Rollback when a migration DID run

This is the painful case. Migrations in this repo are written to be
backward-compatible (additive: ADD COLUMN, CREATE INDEX CONCURRENTLY,
new tables) so the OLD app version still functions against the NEW
schema. **Verify that property** before rolling back the app:

1. Find the migration files in the bad deploy:
   ```bash
   git diff <prev>..<bad> -- packages/infra/db/src/migrations/
   ```
2. Check each: `ADD COLUMN ... NOT NULL` without DEFAULT? `DROP
   COLUMN`? `RENAME`? Anything that **removes** schema is NOT
   backward-compatible. Stop and write a forward fix instead — a
   schema rollback against live data is a one-way trip to a Postgres
   restore (see §1).
3. If migrations are purely additive: redeploy the previous commit
   (same as 6a). The new schema's extra columns / indexes / tables
   are dormant from the old code's perspective.
4. Open a PR that *adds* a follow-up migration to undo the schema
   change in the next forward deploy, rather than running a manual
   `DROP COLUMN` against prod.

### 6c. Cloudflare Pages frontends

Each frontend project (app, cloud, admin, landing) keeps the last 50
deployments. To roll back:

1. Go to the Pages project's Deployments tab in the Cloudflare
   dashboard.
2. Click the last green deployment → "Retry deployment". Cloudflare
   re-promotes that build with the new "current" pointer.
3. Verify in browser; CDN cache may take ~30 s to flip.

There is no "automatic" rollback — Pages doesn't auto-revert on health
check failure (Pages has no concept of health checks). The watch-list
is Sentry: if the new bundle's first-seen alert fires
post-deploy with a high event count, treat that as a regression and
roll back.

### 6d. Terraform rollback

Provider versions pinned via `~>` in `infra/terraform/versions.tf`
mean a `terraform apply` could pull a new minor that introduces a
regression. To pin to a known-good version:

1. Locate the working version in
   `infra/terraform/.terraform.lock.hcl`.
2. Tighten `versions.tf` to that exact version.
3. `terraform init -upgrade=false` then `terraform apply` — confirms
   plan diff is clean before applying.

---

## Tested-restore log

Per CLAUDE.md ("backup that's never been restored is half a backup"),
keep this list current. Each row is a real restore the team has
exercised.

| Date | Procedure | Outcome | Notes |
|---|---|---|---|
| 2026-05-09 | _initial_ | _scheduled_ | First entry created with this runbook. The next monthly `restore-test.yaml` run will populate it. |
