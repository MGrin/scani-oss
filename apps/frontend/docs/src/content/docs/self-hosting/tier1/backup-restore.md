---
title: Backup & restore
description: Postgres is the source of truth. Redis can be regenerated. S3 holds uploads. Back up accordingly.
sidebar:
  order: 7
---

## What lives where

| Data | Where | Critical to back up? |
|---|---|---|
| Holdings, transactions, observations, prices, vaults, groups, accounts, users, sessions, encrypted integration creds | Postgres | **Yes. The whole truth lives here.** |
| BullMQ job state, scheduled-job state, rate-limiter buckets, realtime pub/sub | Redis | Optional. Loss means in-flight jobs are lost; everything else regenerates. |
| Screenshot uploads, CSV imports, file-import payloads | S3 / MinIO | If your retention model needs them. The application can run without them; only the audit trail / re-parse flow is impacted. |
| Code, schema, env config | Git + your secret store | **Yes.** |

## Postgres

### Logical backup (`pg_dump`)

The simplest reliable backup. Compresses well, works across any
Postgres version ≥ 16, can be restored to a different instance.

```sh
# Daily backup, retained for 30 days
docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_dump -U scani --format=custom --no-owner scani \
  > "scani-$(date +%F).dump"
```

For a managed Postgres without a local container, use `pg_dump`
against the URL directly:

```sh
pg_dump "$DATABASE_URL" --format=custom --no-owner \
  > "scani-$(date +%F).dump"
```

Restore:

```sh
pg_restore --clean --if-exists --no-owner --dbname="$DATABASE_URL" \
  scani-2026-05-24.dump
```

### Physical backup / point-in-time recovery

Managed Postgres providers (RDS, Neon, Render, Supabase) all
provide PITR. Use it — it's strictly more powerful than `pg_dump`
and handles WAL streaming.

For self-hosted Postgres, [`wal-g`](https://github.com/wal-g/wal-g)
or [`pgbackrest`](https://pgbackrest.org/) are the standard tools.

### Encrypted credentials are encrypted at rest

User integration credentials (exchange API keys, brokerage tokens)
are stored AES-256-GCM-encrypted with the `ENCRYPTION_KEY` env var.
**The backup is only useful with the matching `ENCRYPTION_KEY`.**

Treat `ENCRYPTION_KEY` like a database backup credential — losing it
means losing the ability to decrypt integration credentials, which
breaks every sync until each user re-enters their keys.

## Redis

You can usually skip backing Redis up. What lives there:

- BullMQ in-flight jobs (lost jobs are retried by ingester schedules
  the next time they fire).
- Rate-limiter counters (regenerate from "now").
- Realtime pub/sub topics (ephemeral by definition).

If you do want to preserve in-flight jobs across a server move:

```sh
# Trigger an AOF rewrite, then copy the file
docker compose -f docker-compose.prod.yml exec redis \
  redis-cli BGREWRITEAOF

docker cp $(docker compose -f docker-compose.prod.yml ps -q redis):/data/appendonly.aof \
  ./redis-aof-$(date +%F).aof
```

Restore by mounting the file into a fresh Redis container's `/data`.

## S3 / MinIO

Cloud providers handle durability. For self-hosted MinIO, the
data lives in the `minio-data` named volume:

```sh
# Snapshot the volume
docker run --rm \
  -v scani_minio-data:/data:ro \
  -v "$PWD":/backup \
  alpine \
  tar -czf "/backup/minio-$(date +%F).tar.gz" -C /data .
```

For real backups, use `mc mirror`:

```sh
docker run --rm --network scani_default \
  minio/mc:latest \
  sh -c "mc alias set local http://minio:9000 minioadmin minioadmin && \
         mc mirror --overwrite local/job-uploads-dev s3://your-backup-bucket/scani"
```

## What a full DR drill looks like

1. Provision a fresh host.
2. Pull the same `SCANI_IMAGE_TAG` you were running.
3. Restore the **same** `.env`, including `ENCRYPTION_KEY`,
   `BETTER_AUTH_SECRET`, `LOG_ID_PEPPER`.
4. Restore Postgres from the most recent dump or PITR snapshot.
5. (Optional) Restore S3 from your backup bucket.
6. Skip Redis — let it rebuild from active jobs and schedules.
7. Boot the compose stack.
8. Sign in. Verify a sync runs (each user's encrypted creds decrypt
   successfully).

If sync runs fail with decryption errors, `ENCRYPTION_KEY` does not
match the backup. There is no recovery from this — users will have
to re-enter their integration credentials.

## Backup retention recommendations

- **Daily** Postgres dump kept for 7 days locally.
- **Weekly** dump kept for 8 weeks in a different storage account.
- **Monthly** dump kept for 12 months in a different region.
- For high-stakes deployments, run a parallel WAL-streaming replica.

## See also

- [Production with docker-compose](/self-hosting/tier1/production/)
- [Required environment variables](/self-hosting/tier1/required-env/) —
  `ENCRYPTION_KEY` notes.
- [Upgrades & version pinning](/self-hosting/tier1/upgrades/)
