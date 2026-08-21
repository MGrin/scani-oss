# syntax=docker/dockerfile:1.7-labs
#
# Multi-stage Bun image for the API service (tRPC). Build stage
# produces a single self-contained binary via `bun build --compile`; the
# runtime stage is a tiny Debian image that only carries the binary +
# curl for the healthcheck. No `node_modules`, no `bun` runtime, no
# `packages/` tree at runtime.

ARG BUN_VERSION=1.3.13

# ---------- deps ----------
FROM oven/bun:${BUN_VERSION} AS deps
WORKDIR /app

# `--parents` preserves directory structure under the glob, so new
# workspaces under `apps/*/*/` or `packages/*/*/` are picked up
# automatically — no Dockerfile churn per new package.
COPY package.json bun.lock ./
# apps/*/package.json picks up single-level workspaces (e.g. apps/e2e).
# apps/*/*/package.json picks up nested workspaces (e.g. apps/backend/api).
COPY --parents apps/*/package.json apps/*/*/package.json packages/*/*/package.json ./

# Filter to api's workspace dep graph only — skips deps reachable only
# through @scani/worker / data-provider / frontend workspaces.
RUN bun install --frozen-lockfile --filter @scani/backend --linker=hoisted

# ---------- build ----------
FROM oven/bun:${BUN_VERSION} AS build
WORKDIR /app

# NODE_ENV is intentionally NOT set at build time. If it were, the
# minifier would fold `process.env.NODE_ENV === 'production'` to a
# compile-time constant — convenient for prod, but it breaks the dev
# compose stack: the binary then thinks it's production regardless of
# the runtime override, so every "required in production" guard fires
# in dev (LOG_ID_PEPPER, https-only URLs, FASTMAIL_API_TOKEN, …).
# Runtime NODE_ENV is set in the runtime stage below; dev compose
# overrides it to "development". The bundle is marginally larger
# because dev/prod branches both ship — acceptable trade-off to keep
# the same image runnable under both NODE_ENVs.

COPY --from=deps /app/node_modules ./node_modules

COPY package.json bun.lock tsconfig.json ./
COPY apps/backend/api ./apps/backend/api
COPY packages ./packages

RUN cd apps/backend/api && bun run build

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
    PORT=3001 \
    HOST=0.0.0.0

# curl: needed by the healthcheck below. ca-certificates: TLS to
# postgres / redis / external APIs from inside the binary.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# Non-root user. The compiled binary runs without bun installed; we just
# need a low-privilege uid.
RUN useradd --create-home --shell /usr/sbin/nologin --uid 1001 app
USER app

COPY --from=build --chown=app:app /app/apps/backend/api/dist/server /app/server

# SC-518: the SQL the compiled binary reads at runtime. Path must match the
# build-time `__dirname` baked into the binary, which is /app/node_modules/...
COPY --from=build --chown=app:app /app/node_modules/bullmq/dist/esm/postgres /app/node_modules/bullmq/dist/esm/postgres

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl --fail --silent --show-error http://localhost:3001/readyz > /dev/null || exit 1

CMD ["/app/server"]
