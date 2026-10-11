# syntax=docker/dockerfile:1.7-labs
#
# Multi-stage Bun image for scani-worker. Build stage produces a single
# self-contained binary via `bun build --compile`; runtime is a tiny
# Debian image carrying the binary only (no HTTP port; no healthcheck —
# Fly observes the machine's exit status, BullMQ liveness is the signal).

ARG BUN_VERSION=1.4.2

FROM oven/bun:${BUN_VERSION} AS deps
WORKDIR /app

# `--parents` preserves directory structure under the glob, so new
# workspaces under `apps/*/*/` or `packages/*/*/` are picked up
# automatically.
COPY package.json bun.lock ./
# `patchedDependencies` in package.json points here; install fails without it.
COPY patches ./patches
# apps/*/package.json picks up single-level workspaces (e.g. apps/e2e).
# apps/*/*/package.json picks up nested workspaces (e.g. apps/backend/worker).
COPY --parents apps/*/package.json apps/*/*/package.json packages/*/*/package.json ./

# Filter to worker's workspace dep graph only. Worker depends on
# @scani/providers-google-sheets (the pricing cron uses Google Sheets
# fallback).
#
# SC-794. `--production` is load-bearing here, not a size tweak, and it only
# works in combination with `@scani/data-provider` being a devDependency of
# `@scani/cloud-client` — neither half does anything alone. The chain it cuts:
#
#   @scani/worker -> @scani/cloud-client -> @scani/data-provider
#     -> better-auth -> peerDependencies.next  (declared optional)
#
# bun installs that optional peer whenever bun.lock already carries a
# satisfying `next`, which this lockfile does. An optional peer with NO
# lockfile entry is not installed — so this does not reproduce in a
# standalone package, only in a workspace whose lockfile has the entry.
# cloud-client's only reference to data-provider is a single `import type`,
# so the worker was downloading Next.js to compile a queue consumer.
# Measured at this change, deps stage: 239 packages / 809 MB before,
# 138 / 332 MB after.
#
# The worker is the only backend app that can take this: api and data-provider
# declare `better-auth` themselves and legitimately need it, and
# apps/frontend/app builds with Vite, which needs devDependencies.
#
# Falsifier, after any change to this stage or to that manifest:
#   docker build --target deps -t sc794 -f apps/backend/worker/Dockerfile .
#   docker run --rm sc794 sh -c 'ls node_modules/next >/dev/null 2>&1 \
#     && echo REGRESSED || echo ok'
#   docker run --rm sc794 sh -c 'ls node_modules/bullmq >/dev/null 2>&1 \
#     && echo ok || echo BROKEN'
# The second is a must-be-FOUND control and is not optional: the subject reads
# ABSENT, so a probe that finds nothing at all reads exactly like a clean pass.
RUN bun install --frozen-lockfile --filter @scani/worker --linker=hoisted --production

FROM oven/bun:${BUN_VERSION} AS build
WORKDIR /app

# NODE_ENV intentionally not set here — see apps/backend/api/Dockerfile
# for the full rationale. Short version: baking NODE_ENV=production at
# build time folds `isProduction` to a compile-time constant, which
# makes the dev compose stack unbootable. Runtime NODE_ENV is set in
# the runtime stage below.

COPY --from=deps /app/node_modules ./node_modules

COPY package.json bun.lock tsconfig.json ./
COPY apps/backend/worker ./apps/backend/worker
COPY packages ./packages

RUN cd apps/backend/worker && bun run build

# SC-518. BullMQ 6.2's Postgres backend read every SQL command with
# `readFileSync` at RUNTIME, which `bun build --compile` does not bundle, so the
# image used to copy the .sql files beside the binary. 6.3 inlines them into
# `sql-scripts.js` (taskforcesh/bullmq#4603) and has no .sql files at all, which
# is how the old file check aborted deploy #461 (SC-1677).
#
# THIS ASSERTION IS STILL A CONDITION. Without the SQL every enqueue returns
# 500 from an image that builds and passes every other check. So assert both
# halves of "the binary needs nothing on disk": the loader imports the inlined
# scripts and reads no file, and the compiled binary itself carries add_job's
# SQL. A release that goes back to reading files fails here, not in production.
RUN grep -q "from './sql-scripts'" node_modules/bullmq/dist/esm/postgres/sql-loader.js \
    && ! grep -q readFileSync node_modules/bullmq/dist/esm/postgres/sql-loader.js \
    && grep -q 'Insert a single job, routing it to waiting or delayed' apps/backend/worker/dist/server \
    || (echo "SC-518: the compiled binary does not carry bullmq's Postgres SQL — it cannot enqueue" && exit 1)

# SC-963. A patch that did not apply builds a worker that pins the Neon compute
# awake again, and nothing else fails. Assert on the patched line itself.
RUN grep -q 'deferStalledCheckWhileIdle' node_modules/bullmq/dist/esm/classes/worker.js \
    && grep -q 'reconnectsListenOnNextWait' node_modules/bullmq/dist/esm/postgres/postgres-queue-backend.js \
    || (echo "SC-963: patches/bullmq@6.3.12.patch is not applied — the idle worker would keep Postgres awake" && exit 1)

FROM debian:bookworm-slim AS runtime
WORKDIR /app

ARG SCANI_COMMIT=
ARG SCANI_CORE_BUILD=
ARG SCANI_RELEASE_VERSION=
ENV SERVICE_VERSION=${SCANI_COMMIT} SCANI_CORE_BUILD=${SCANI_CORE_BUILD} \
    SCANI_RELEASE_VERSION=${SCANI_RELEASE_VERSION}

ENV NODE_ENV=production

# redis-server: with REDIS_EMBEDDED=1 this machine hosts the queue Redis
# for the whole backend over Fly 6PN (see docker-entrypoint.sh).
# util-linux provides setpriv, which the entrypoint uses to drop from
# root (needed once at boot to chown the /data volume) to the app user.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates redis-server util-linux \
    && rm -rf /var/lib/apt/lists/*

# pg_dump / pg_restore for the nightly `db-backup` job (SC-793).
#
# THE MAJOR IS PINNED AND IT IS NOT DEBIAN'S. `apt-get install postgresql-client`
# on bookworm gives **15.19**, and this database is Neon PostgreSQL **16** — a
# client older than the server does not degrade, it refuses:
#
#   pg_dump: error: aborting because of server version mismatch
#   pg_dump: detail: server version: 16.15; pg_dump version: 15.19
#
# Measured 2026-08-29 against a real PG16, both clients, same URL and flags:
# 15.19 exits 1 with zero bytes, 16.15 exits 0 with an archive. So the PGDG
# repository is the requirement, not a preference — and it costs 80 KB more
# than the wrong answer (runtime stage 34.13 -> 49.21 MB, against 49.13 for
# Debian's 15).
#
# `--file` is written by the job under /tmp and removed in a `finally`.
#
# When Neon moves to 17 this refuses on the same line, loudly, on the next
# fire — bump the major here. That is the safe direction: SC-259 is the other
# one, where a NEWER client wrote an archive that errored on restore while the
# data in it was fine.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl gnupg \
    && install -d /usr/share/postgresql-common/pgdg \
    && curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
       https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
       > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends postgresql-client-16 \
    && apt-get purge -y curl gnupg && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

# The image is useless for this job without them, and `COPY`/`RUN` above cannot
# fail loudly if a future base image or repo move drops the package. Assert on
# the binaries the processor actually spawns, and on the MAJOR, not merely on
# their presence: a 15 client here builds green and refuses at 06:00.
RUN pg_dump --version | grep -qE '^pg_dump \(PostgreSQL\) 16\.' \
    && pg_restore --version | grep -qE '^pg_restore \(PostgreSQL\) 16\.' \
    || (echo "SC-793: pg_dump/pg_restore are not PostgreSQL 16 — db-backup would refuse against Neon 16" && exit 1)

RUN useradd --create-home --shell /usr/sbin/nologin --uid 1001 app

# HOME FOR THE DROPPED PROCESS (SC-869).
#
# This image has no `USER` directive — the container has to start as root so the
# entrypoint can chown the /data volume — and drops with `setpriv`, which
# changes uid/gid and leaves the environment ALONE, unlike `su -` or
# `runuser -l`. Without this line the server runs as uid 1001 still carrying
# root's `HOME=/root`, a directory uid 1001 cannot even traverse.
#
# That is not cosmetic: it failed the nightly `db-backup` job on every run it
# ever had. libpq resolves its OPTIONAL client certificate to
# `$HOME/.postgresql/postgresql.crt` and treats an EACCES from that stat as
# fatal where it treats ENOENT as "no client cert, carry on" —
#
#   pg_dump: error: connection to server at "…" port 5432 failed: could not
#   open certificate file "/root/.postgresql/postgresql.crt": Permission denied
#
# `ENV` rather than wrapping the two `setpriv` calls, because it covers every
# child process the server ever spawns rather than the one that happened to be
# caught. Do NOT reach for `setpriv --reset-env`: that clears the whole
# environment the server is configured by.
ENV HOME=/home/app

# A wrong `HOME` is silent — the image builds, the server boots, and one job
# fails once a day at 06:00 into a report that is only read when it is already
# too late. So assert the thing that actually matters, through the real drop:
# the user this image runs as can enter its own home. `cd` is the syscall that
# failed above.
RUN setpriv --reuid app --regid app --init-groups sh -c 'cd "$HOME"' \
    || (echo "SC-869: uid 1001 cannot enter HOME=$HOME — db-backup's pg_dump would fail on libpq's default client-cert path" && exit 1)

COPY --from=build --chown=app:app /app/apps/backend/worker/dist/server /app/server

COPY --chown=app:app apps/backend/worker/docker-entrypoint.sh /app/docker-entrypoint.sh
COPY --chown=app:app apps/backend/worker/memory-watchdog.sh /app/memory-watchdog.sh
RUN chmod +x /app/docker-entrypoint.sh /app/memory-watchdog.sh

CMD ["/app/docker-entrypoint.sh"]
