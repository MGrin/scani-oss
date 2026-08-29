# syntax=docker/dockerfile:1.7-labs
#
# Multi-stage Bun image for scani-worker. Build stage produces a single
# self-contained binary via `bun build --compile`; runtime is a tiny
# Debian image carrying the binary only (no HTTP port; no healthcheck —
# Fly observes the machine's exit status, BullMQ liveness is the signal).

ARG BUN_VERSION=1.3.13

FROM oven/bun:${BUN_VERSION} AS deps
WORKDIR /app

# `--parents` preserves directory structure under the glob, so new
# workspaces under `apps/*/*/` or `packages/*/*/` are picked up
# automatically.
COPY package.json bun.lock ./
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

# SC-518. BullMQ v6's Postgres backend loads every SQL command with
# `readFileSync` at RUNTIME (`sql-loader.ts` joins `__dirname` with
# `commands/`), and `bun build --compile` bundles JavaScript but NOT data
# files. So the compiled binary looks for these on disk and the runtime image
# has no `node_modules`. Without them every enqueue returns 500 — the image
# builds and passes every check, and fails on first use.
#
# THIS ASSERTION IS A CONDITION, NOT A NICETY. It is the only thing standing
# between a bullmq patch release relocating these files and a green image that
# 500s in production: `COPY` does not fail when it matches an empty directory,
# so without this the breakage is silent. Assert on a FILE THE LOADER ACTUALLY
# READS, not on the directory — a directory can exist and be empty.
#
# Remove it only when bullmq inlines its SQL — upstream taskforcesh/bullmq#4603
# (see also
# taskforcesh/bullmq#4601).
RUN test -s node_modules/bullmq/dist/esm/postgres/commands/add_job.sql \
    && test -s node_modules/bullmq/dist/esm/postgres/migrations/0001_schema.sql \
    || (echo "SC-518: bullmq Postgres SQL assets missing — the compiled binary cannot enqueue" && exit 1)

FROM debian:bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production

# redis-server: with REDIS_EMBEDDED=1 this machine hosts the queue Redis
# for the whole backend over Fly 6PN (see docker-entrypoint.sh).
# util-linux provides setpriv, which the entrypoint uses to drop from
# root (needed once at boot to chown the /data volume) to the app user.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates redis-server util-linux \
    && rm -rf /var/lib/apt/lists/*

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

# SC-518: the SQL the compiled binary reads at runtime. Path must match the
# build-time `__dirname` baked into the binary, which is /app/node_modules/...
COPY --from=build --chown=app:app /app/node_modules/bullmq/dist/esm/postgres /app/node_modules/bullmq/dist/esm/postgres
COPY --chown=app:app apps/backend/worker/docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

CMD ["/app/docker-entrypoint.sh"]
