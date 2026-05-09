# Disaster Recovery Runbook

This is the cold-start guide for the four production-bearing surfaces:

1. **Postgres (Neon)** — primary durable store.
2. **Redis (Upstash)** — BullMQ + rate-limiter + WebSocket pub/sub.
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

## 2. Redis flush + rebuild (Upstash)

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

1. Drain the worker first to avoid deleting jobs mid-execution:
   `flyctl machine list -a scani-worker | awk 'NR>1 {print $1}' | xargs -I{} flyctl machine stop {} -a scani-worker`.
2. Connect to Upstash console → Data Browser → `FLUSHALL` (only on the
   prod Redis, never on a shared Redis).
3. Restart the worker: `flyctl machine list -a scani-worker | xargs … start`.
   The worker re-registers every repeatable schedule via
   `JobScheduler.upsertAll()` at boot
   (`apps/backend/worker/src/index.ts`). User-job mirror rows in
   `user_jobs` will be picked up by `reconcile-orphaned-user-jobs` and
   marked `failed` so the user can retry from the UI.

### What you lose

- All in-flight jobs (queued or active). They become orphans in
  `user_jobs`; the reconciler marks them `failed` within 1 minute and
  the user retries.
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

```bash
flyctl secrets set --app scani-backend BETTER_AUTH_SECRET="$(openssl rand -hex 32)"
```

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

1. Check Neon dashboard → connection count. The branch limit is ~100;
   our default per-app pool is 20 (`packages/infra/db/src/connection.ts:62`).
   60 across three apps with one machine each = healthy. If it's
   higher, a leak is in flight.
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

## Tested-restore log

Per CLAUDE.md ("backup that's never been restored is half a backup"),
keep this list current. Each row is a real restore the team has
exercised.

| Date | Procedure | Outcome | Notes |
|---|---|---|---|
| 2026-05-09 | _initial_ | _scheduled_ | First entry created with this runbook. The next monthly `restore-test.yaml` run will populate it. |
