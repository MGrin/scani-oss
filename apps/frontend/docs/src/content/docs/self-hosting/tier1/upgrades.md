---
title: Upgrades & version pinning
description: How releases are cut, how image tags work, and the safe upgrade flow with rollback.
sidebar:
  order: 8
---

## Releases

Releases are cut by [release-please](https://github.com/googleapis/release-please)
watching `main`. Conventional commits drive the version bump:

| Commit prefix | Triggers | Effect (pre-1.0) |
|---|---|---|
| `feat:` | release | Minor bump (`0.X.0`) — `bump-minor-pre-major: true`. |
| `fix:` | release | Patch bump. |
| `docs:`, `refactor:`, `chore:` | none | No release. |
| `feat!:` or `BREAKING CHANGE:` footer | release | Minor bump pre-1.0, major bump post-1.0. |

When release-please opens its release PR and it merges, a semver tag
is created (`v0.7.2`). Release-please explicitly dispatches
`docker-publish.yml` at that tag to publish `:0.7.2`, `:0.7`, `:0`
and `:latest`. A tag push can also trigger publication.

## Image tags

| Tag | What it points at |
|---|---|
| `:latest` | The most recent published semver release. This alias moves. |
| `:1.2.3` | A specific semver release. The safe production default. |
| `:1.2` | Tracks the most recent patch within minor `1.2.x`. |
| `:1` | Tracks the most recent minor within major `1.x.x`. |

## The safe upgrade flow

Use a maintenance window. Every API and worker sharing the database must stop
before migration, including replicas outside this Compose project. A read-only
frontend does not stop background writers. Leave Postgres, Redis and storage
running. Never remove data volumes during an upgrade.

1. **Read the release notes and pin one published version.** Save the same
   `SCANI_IMAGE_TAG` in `.env`, then export it for every command below:

   ```sh
   export SCANI_IMAGE_TAG=0.56.0  # choose a published release
   docker compose -f docker-compose.prod.yml --profile migrate pull api worker data-provider frontend-app migrate
   ```

   This includes `api`, `worker`, `data-provider`, `frontend-app` and `migrate`.
   Record image digests and keep the previous version and configuration.
   Semver tags are the production default; mutable aliases can change between pulls.

2. **Drain traffic and jobs, stop all old application processes, then back up.**
   Disable external traffic and any other deployment that could restart old replicas.
   For this Compose project:

   ```sh
   docker compose -f docker-compose.prod.yml stop --timeout 60 frontend-app api worker data-provider
   running=$(docker compose -f docker-compose.prod.yml ps --status running --quiet frontend-app api worker data-provider) || exit 1
   [ -z "$running" ] || { echo "Application services are still running" >&2; exit 1; }
   ```

   Verify other replicas separately. With all writers stopped, take the final full
   Postgres snapshot. For the bundled database and default database/user names:

   ```sh
   umask 077
   docker compose -f docker-compose.prod.yml exec -T postgres \
     pg_dump -U scani -d scani --format=custom --no-owner > scani-before-upgrade.dump
   cp -p .env .env.before-upgrade
   ```

   Require a successful dump and verify it with `pg_restore --list` before continuing.
   Managed databases can use their verified snapshot procedure instead. Preserve
   encryption material and storage backups. See [Backup & restore](/self-hosting/tier1/backup-restore/).

3. **Apply migrations with the pinned image while old services stay stopped.**

   ```sh
   docker compose -f docker-compose.prod.yml --profile migrate run --rm migrate
   ```

   Require exit code 0. If stop, backup or migration fails, halt the upgrade.
   Keep maintenance enabled and application services stopped. Inspect the error;
   do not start the old images against a partly upgraded database.

4. **Start matching new services and verify them before reopening traffic.**

   ```sh
   docker compose -f docker-compose.prod.yml up -d --wait --wait-timeout 180 --no-deps frontend-app api worker data-provider
   curl --fail http://localhost:8080/api/readyz
   curl --fail http://localhost:8080/version.json
   docker compose -f docker-compose.prod.yml logs --tail 100 api worker
   ```

   Adapt the local port to your configuration. Require API readiness, the expected
   release/commit, and the new worker's queue registration. Exercise a legacy undo,
   an account read and a supported sync before ending maintenance. Old API or worker
   replicas must not rejoin. Nginx `/healthz` alone does not prove application readiness.

5. **If rerunning the installer, confirm the same maintenance prerequisites.**
   The installer uses the pin in `.env`. An exported override must match that pin.
   Existing installations require a full semver pin and this explicit attestation:

   ```sh
   SCANI_UPGRADE_BACKUP_CONFIRMED=1 bash scripts/self-host.sh
   ```

   Use the current installer from your chosen release, or download it into the
   install directory before running it. The confirmation means you already drained
   all replicas and saved the final snapshot. It does not create or validate a backup.
   Data services must remain available. The installer repeats local stop/verification
   before migration. It starts missing data services without recreating existing
   containers, then starts matching application services. This also supports a
   rerun after `SCANI_SKIP_UP=1` or a failed first install. A failed
   migration leaves those services stopped; success waits for new service health.

## Rollback

Prefer a compatible forward fix after schema changes. **An additive migration does
not guarantee old binaries can use the new database.** Image-only rollback is unsafe
for the quote journal and category changes below.

To downgrade, enter maintenance and stop every application writer. Restore the
verified pre-upgrade database snapshot with its matching old images and configuration.
Account for writes after that snapshot before restoring it. Rehearse the restore in
an isolated database first. Keep traffic disabled until the matching stack passes
readiness and data checks. Never treat a portable account export as a schema downgrade.

## What CI establishes

CI runs migration and application tests. A clean migration test does not establish
mixed-version fleet compatibility. The maintenance barrier above remains required.
`docker-publish.yml` publishes five multi-arch images from version tags; PR and
branch-dispatch builds are amd64 smoke checks without publication.

## Notes for specific versions

### 0.56.0

**Coordinated downtime is required when upgrading from 0.55.6.** The nullable
`holdings.value_quote` column changes journal row images. Old API undo can falsely
refuse or try restoring a calculator-owned quote after DDL. The new API handles
historical images, but it must replace the old API before traffic resumes.

Category rules add definitions and retained preview/apply/undo history. New API and
erasure workers share an owner lock and a complete erasure manifest. Old workers
lack both and can leave rule history behind or fail on category references. Replace
all old workers before enabling new category writes. A journal-only bridge does not
make a rolling upgrade safe.

All new account exports use **backup format 3**, including accounts without saved
rules. Definitions are included; preview/apply/undo history remains instance-local.
New readers accept older formats. Old readers safely refuse format 3, so upgrade a
restore destination first. Keep a full pre-upgrade Postgres snapshot for downgrade.

### 0.53.0

**New outbound host.** Exchange rates are now read from
`api.frankfurter.dev`; the old `api.frankfurter.app` only redirects there. If
your install restricts outbound traffic, allow `api.frankfurter.dev` before
upgrading. No new key and no new environment variable.

**A migration can stop this upgrade, and it changes nothing when it does.**
`20261004084212` adds a check that every stored price in `token_prices` is a
positive number in plain decimal notation. If any stored row is zero,
negative or written another way, the migrate step (step 3) fails with
`23514` naming `token_prices_price_positive_decimal_chk`. Nothing is applied
and the new version does not start. Check before you upgrade; the answer
must be `0`:

```sh
docker compose -f docker-compose.prod.yml exec -T postgres psql -U scani -d scani -c "
  SELECT count(*) FROM token_prices
   WHERE NOT (CASE WHEN price ~ '^[0-9]{1,64}(\.[0-9]{1,64})?([eE][-+]?[0-9]{1,3})?\$'
                   THEN price::numeric > 0 ELSE false END);"
```

If it is not `0`, back the table up first, then delete those rows. Scani
already ignores a price that is not positive, so nothing reads them:

```sh
docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_dump -U scani --format=custom --no-owner --table=token_prices scani \
  > token_prices-before-0.53.0.dump

docker compose -f docker-compose.prod.yml exec -T postgres psql -U scani -d scani -c "
  DELETE FROM token_prices
   WHERE NOT (CASE WHEN price ~ '^[0-9]{1,64}(\.[0-9]{1,64})?([eE][-+]?[0-9]{1,3})?\$'
                   THEN price::numeric > 0 ELSE false END);"
```

Then run the check again and continue from step 3.

## See also

- [Backup & restore](/self-hosting/tier1/backup-restore/)
- [Release flow](/contributing/release-flow/)
- [Production with docker-compose](/self-hosting/tier1/production/)
