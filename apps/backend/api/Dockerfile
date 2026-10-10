# syntax=docker/dockerfile:1.7-labs
#
# Multi-stage Bun image for the API service (tRPC). Build stage
# produces a single self-contained binary via `bun build --compile`; the
# runtime stage is a tiny Debian image that only carries the binary +
# curl for the healthcheck. No `node_modules`, no `bun` runtime, no
# `packages/` tree at runtime.

ARG BUN_VERSION=1.4.2

# ---------- deps ----------
FROM oven/bun:${BUN_VERSION} AS deps
WORKDIR /app

# `--parents` preserves directory structure under the glob, so new
# workspaces under `apps/*/*/` or `packages/*/*/` are picked up
# automatically — no Dockerfile churn per new package.
COPY package.json bun.lock ./
# `patchedDependencies` in package.json points here; install fails without it.
COPY patches ./patches
# apps/*/package.json picks up single-level workspaces (e.g. apps/e2e).
# apps/*/*/package.json picks up nested workspaces (e.g. apps/backend/api).
COPY --parents apps/*/package.json apps/*/*/package.json packages/*/*/package.json ./

# Filter to api's workspace dep graph only — skips deps reachable only
# through @scani/worker / data-provider / frontend workspaces.
#
# `--omit=peer` keeps Next.js out (SC-804). `better-auth` declares `next` as an
# OPTIONAL peer, and bun installs an optional peer whenever `bun.lock` already
# resolves it — which it does, for the frontends — so this stage downloaded
# `next` and its swc binaries for a server that never imports them.
# `--omit=optional` does not reach optional peers, and `--production` keeps it.
# The flag drops REQUIRED peers too, so elysia's (`file-type`, `openapi-types`)
# are declared in apps/backend/api/package.json, where a dependency is not a
# peer and survives. `scripts/tests/backend-images-omit-peers.test.ts` fails
# when a required peer of this graph is left undeclared.
RUN bun install --frozen-lockfile --filter @scani/backend --linker=hoisted --omit=peer

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

# SC-1646: patches/@better-auth%2Foauth-provider@1.7.7.patch makes a concurrent
# first start skip the duplicate MCP resource seed by SQLSTATE. The plugin is
# bundled into the binary, so the check reads the binary.
RUN grep -aqF '==="23505"||/unique|duplicate|UNIQUE/i' apps/backend/api/dist/server \
    || (echo "SC-1646: the oauth-provider patch is not in the compiled api binary" && exit 1)

# ---------- runtime ----------
# SC-518. BullMQ 6.2's Postgres backend read every SQL command with
# `readFileSync` at RUNTIME, which `bun build --compile` does not bundle, so the
# image used to copy the .sql files beside the binary. 6.3 inlines them into
# `sql-scripts.js` (taskforcesh/bullmq#4603) and has no .sql files at all, which
# is how the old file check aborted deploys #461 and #465 (SC-1677).
#
# THIS ASSERTION IS STILL A CONDITION. Without the SQL every enqueue returns
# 500 from an image that builds and passes every other check. So assert both
# halves of "the binary needs nothing on disk": the loader imports the inlined
# scripts and reads no file, and the compiled binary itself carries add_job's
# SQL. A release that goes back to reading files fails here, not in production.
RUN grep -q "from './sql-scripts'" node_modules/bullmq/dist/esm/postgres/sql-loader.js \
    && ! grep -q readFileSync node_modules/bullmq/dist/esm/postgres/sql-loader.js \
    && grep -q 'Insert a single job, routing it to waiting or delayed' apps/backend/api/dist/server \
    || (echo "SC-518: the compiled binary does not carry bullmq's Postgres SQL — it cannot enqueue" && exit 1)

FROM debian:bookworm-slim AS runtime
WORKDIR /app

ARG SCANI_COMMIT=
ARG SCANI_CORE_BUILD=
ARG SCANI_RELEASE_VERSION=
ENV SERVICE_VERSION=${SCANI_COMMIT} SCANI_CORE_BUILD=${SCANI_CORE_BUILD} \
    SCANI_RELEASE_VERSION=${SCANI_RELEASE_VERSION}

ENV NODE_ENV=production \
    PORT=3001 \
    HOST=::

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

EXPOSE 3001

# The probe reads PORT rather than hardcoding it (SC-492).
#
# It used to curl 3001 literally. That is correct only while every compose in
# use happens to set PORT: 3001 — and one of them does not, so this container
# reported `unhealthy` for months while its own log read
# `Scani Backend Server started successfully | port=8080`.
#
# The failure is silent in the way that matters: `docker ps` says `unhealthy`,
# which is also what a genuinely broken api says, so the one signal that would
# report a real fault was already red and unreadable. Fly cannot catch it
# either — it never executes a Dockerfile HEALTHCHECK, it runs its own
# `[checks]` against `internal_port`.
#
# `${PORT:-3001}` is expanded by the shell at RUN time, not by the builder:
# HEALTHCHECK takes no build-time substitution and this is shell form. So one
# image is correct at whatever PORT it is given, and a compose that moves the
# port can no longer break the probe without saying so. EXPOSE stays literal —
# it DOES take build-time substitution, is documentation only, and names the
# default.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl --fail --silent --show-error "http://localhost:${PORT:-3001}/readyz" > /dev/null || exit 1

CMD ["/app/server"]
