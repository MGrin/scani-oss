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
COPY --parents apps/*/*/package.json packages/*/*/package.json ./

# Filter to api's workspace dep graph only — skips deps reachable only
# through @scani/worker / data-provider / frontend workspaces.
RUN bun install --frozen-lockfile --filter @scani/backend

# ---------- build ----------
FROM oven/bun:${BUN_VERSION} AS build
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules

COPY package.json bun.lock tsconfig.json ./
COPY apps/backend/api ./apps/backend/api
COPY packages ./packages

RUN cd apps/backend/api && bun run build

# ---------- runtime ----------
FROM debian:bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=8080 \
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

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl --fail --silent --show-error http://localhost:8080/health > /dev/null || exit 1

CMD ["/app/server"]
