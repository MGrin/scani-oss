# syntax=docker/dockerfile:1.7-labs
#
# Multi-stage Bun image for the data-provider service. Build stage produces a
# self-contained binary via `bun build --compile`; runtime is a tiny
# Debian image carrying the binary + curl for the healthcheck.

ARG BUN_VERSION=1.3.13

# ---------- deps ----------
FROM oven/bun:${BUN_VERSION} AS deps
WORKDIR /app

# `--parents` preserves directory structure under the glob, so new
# workspaces are picked up automatically.
COPY package.json bun.lock ./
# apps/*/package.json picks up single-level workspaces (e.g. apps/e2e).
# apps/*/*/package.json picks up nested workspaces (e.g. apps/backend/data-provider).
COPY --parents apps/*/package.json apps/*/*/package.json packages/*/*/package.json ./

# Filter to data-provider's workspace dep graph only. data-provider
# does NOT depend on @scani/providers-google-sheets (cloud-mode skips
# Google Sheets — per-user sheet config is backend-side DB state), so
# this filter drops `googleapis` (~180MB) from the image entirely.
RUN bun install --frozen-lockfile --filter @scani/data-provider --linker=hoisted

# ---------- build ----------
FROM oven/bun:${BUN_VERSION} AS build
WORKDIR /app

# NODE_ENV intentionally not set here — see apps/backend/api/Dockerfile
# for the full rationale. Short version: baking NODE_ENV=production at
# build time folds `isProduction` to a compile-time constant, which
# makes the dev compose stack unbootable. Runtime NODE_ENV is set in
# the runtime stage below.

COPY --from=deps /app/node_modules ./node_modules

COPY package.json bun.lock tsconfig.json ./
COPY apps/backend/data-provider ./apps/backend/data-provider
COPY packages ./packages

RUN cd apps/backend/data-provider && bun run build

# ---------- runtime ----------
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

ENV NODE_ENV=production \
    PORT=8082 \
    HOST=0.0.0.0

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --shell /usr/sbin/nologin --uid 1001 app
USER app

COPY --from=build --chown=app:app /app/apps/backend/data-provider/dist/server /app/server

# SC-518: the SQL the compiled binary reads at runtime. Path must match the
# build-time `__dirname` baked into the binary, which is /app/node_modules/...
COPY --from=build --chown=app:app /app/node_modules/bullmq/dist/esm/postgres /app/node_modules/bullmq/dist/esm/postgres

EXPOSE 8082

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl --fail --silent --show-error http://localhost:8082/health > /dev/null || exit 1

CMD ["/app/server"]
