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
is pushed (`v0.7.2`), which triggers the `docker-publish.yml`
workflow to build and publish images tagged `:0.7.2`, `:0.7`, `:0`,
and update `:latest`.

## Image tags

| Tag | What it points at |
|---|---|
| `:latest` | The most recent push to `main`. Use only for staging or aggressive dev. |
| `:sha-<short>` | A specific commit. Useful for pinning to a known-good build. |
| `:1.2.3` | A specific semver release. The safe production default. |
| `:1.2` | Tracks the most recent patch within minor `1.2.x`. |
| `:1` | Tracks the most recent minor within major `1.x.x`. |

## The safe upgrade flow

1. **Pin a version** in `.env`:

   ```ini
   SCANI_IMAGE_TAG=1.2.3
   ```

2. **Read the changelog.** The `CHANGELOG.md` in the repo is generated
   by release-please; it lists every feature and fix in the new
   version, plus any breaking changes (marked with `!`).

3. **Back up Postgres.** Always. See
   [Backup & restore](/self-hosting/tier1/backup-restore/).

4. **Pull the new images.**

   ```sh
   SCANI_IMAGE_TAG=1.3.0 docker compose -f docker-compose.prod.yml pull
   ```

5. **Recreate the containers.**

   ```sh
   SCANI_IMAGE_TAG=1.3.0 docker compose -f docker-compose.prod.yml up -d
   ```

   Migrations run automatically on first boot. Watch the logs:

   ```sh
   docker compose -f docker-compose.prod.yml logs -f api worker
   ```

6. **Verify.** Hit the SPA. Trigger a manual sync on a connected
   integration. Check the dashboard headline.

7. **Pin the new version** in `.env` so subsequent `pull`s don't
   surprise you.

## Rollback

If something is wrong:

```sh
SCANI_IMAGE_TAG=1.2.3 docker compose -f docker-compose.prod.yml pull
SCANI_IMAGE_TAG=1.2.3 docker compose -f docker-compose.prod.yml up -d
```

**Rollback caveat:** if the new release included a Drizzle migration
that was applied, rolling back the image will leave Postgres on the
newer schema. Most migrations are additive (new columns, new tables,
new indexes) and the older code will read the newer schema fine.
Migrations that change types or drop columns are flagged in the
changelog and require a `pg_restore` from the pre-upgrade backup if
you need to roll back.

## What to do when an upgrade introduces a breaking change

Breaking changes are flagged in the changelog and (when meaningful)
have their own migration notes. The pattern is usually:

1. The new release ships the new schema and supports both the old
   and new shape in code.
2. You upgrade in place. Both shapes work; new writes go to the new
   shape.
3. A future release removes the old-shape support, after enough time
   has passed for everyone to upgrade.

For this to be safe, **don't skip releases**. Upgrading from `1.2.x`
directly to `2.0.x` is supported but pays the full migration cost in
one step. Upgrading one release at a time costs less and surfaces
problems earlier.

## CI verifies the upgrade path

The `ci.yml` workflow runs the migration suite on every PR that
touches `packages/infra/db/`. Migrations that fail at all-up are
caught before merge. The `docker-publish.yml` workflow builds
multi-arch images on every push to main; production images are only
tagged from semver-tag pushes, which only happen after the
release-please PR merges (which itself only fires on green CI).

## See also

- [Backup & restore](/self-hosting/tier1/backup-restore/)
- [Release flow](/contributing/release-flow/)
- [Production with docker-compose](/self-hosting/tier1/production/)
