---
title: Migrate MinIO to SeaweedFS
description: Copy existing S3 objects safely before switching the bundled storage engine.
sidebar:
  order: 5
---

New installs use SeaweedFS 4.47, pinned by image digest. Existing MinIO data
**cannot** be mounted into SeaweedFS: their disk formats are different. Keep the
old `minio-data` volume and its credentials until the migration is verified.
Upgrading the compose file alone creates an empty `seaweedfs-data` volume; it
does not copy your files.

## Copy before switching

1. Back up Postgres, `.env` and the current compose file. Record your actual
   compose project name and bucket name. Use that same project name throughout.
2. Stop API and worker so uploads and background jobs cannot change files.
   Leave the existing MinIO running. Do not run `down -v` or `SCANI_RESET=1`.
3. Start **only** the SeaweedFS service from the new compose file, temporarily
   with `SEAWEEDFS_S3_HOST_PORT=9002` so it can coexist with MinIO on port 9000.
   Set `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` and `S3_BUCKET` to your chosen
   local storage credentials and existing bucket name. These are infrastructure
   secrets, not new cloud-provider API keys.
4. Configure two authenticated S3 remotes in `rclone`: `old` at your MinIO
   endpoint, and `new` at `http://127.0.0.1:9002`. Choose S3-compatible storage,
   explicit credentials, and path-style access. Keep the config protected and
   out of git. Do not put credentials directly on command lines.
5. Copy and verify all objects, replacing `job-uploads` with your bucket:

```sh
rclone copy old:job-uploads new:job-uploads --metadata
rclone check old:job-uploads new:job-uploads --download
```

`--download` verifies content even when multipart ETags differ between stores.
Do not rely only on object counts. These commands copy current objects; if you
use versioning, retention locks or custom bucket policies, export and restore
those separately before cutover. Scani's bundled bucket does not enable them.

## Cut over and verify

6. Stop the old MinIO service without deleting its volume. Set the SeaweedFS
   host port back to 9000 (or your chosen port), then recreate SeaweedFS.
7. Set `S3_ENDPOINT=http://seaweedfs:8333` on API and worker. Set
   `S3_PUBLIC_ENDPOINT` to the browser-reachable HTTPS S3 origin. Ensure the
   reverse proxy preserves the original Host header and path. Keep the same
   bucket and object keys, so existing database references remain valid.
8. Start API and worker. Open an existing document, download it, upload a new
   document and process an import. Verify signed uploads and downloads, and
   confirm an unsigned object read is denied.
9. After verification, set `SCANI_STORAGE_MIGRATED=1` in your protected `.env`
   so the installer can distinguish a completed migration from an empty new
   bucket while the old MinIO volume remains.
10. Take a SeaweedFS backup and test restoring it into an isolated instance.
   Retain the old MinIO volume and original compose file through your rollback
   window. Remove them only after you are satisfied with the migration.

For rollback, stop writers, copy and verify any **new** objects back to MinIO,
restore the previous S3 endpoint/configuration, then restart the old service and
writers. Pointing at the old bucket without copying post-cutover uploads back
would leave those documents missing.

Tier 2 still uses customer-owned S3 after this change. Only processing inputs
travel to Scani Cloud; neither this migration nor a tier change uploads your
bucket to Scani. See [Tier 2 wiring](/self-hosting/tier2/wiring/) and
[backup and restore](/self-hosting/tier1/backup-restore/).
