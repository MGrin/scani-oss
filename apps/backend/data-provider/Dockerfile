# syntax=docker/dockerfile:1.7-labs
#
# Multi-stage Bun image for scani-data-provider. Build stage produces a
# self-contained binary via `bun build --compile`; runtime is a tiny
# Debian image carrying the binary + curl for the healthcheck.

ARG BUN_VERSION=1.3.13

# ---------- deps ----------
FROM oven/bun:${BUN_VERSION} AS deps
WORKDIR /app

# `--parents` preserves directory structure under the glob, so new
# workspaces are picked up automatically.
COPY package.json bun.lock ./
COPY --parents apps/*/*/package.json packages/*/*/package.json ./

# Filter to data-provider's workspace dep graph only. data-provider
# does NOT depend on @scani/providers-google-sheets (cloud-mode skips
# Google Sheets — per-user sheet config is backend-side DB state), so
# this filter drops `googleapis` (~180MB) from the image entirely.
RUN bun install --frozen-lockfile --filter @scani/data-provider

# ---------- build ----------
FROM oven/bun:${BUN_VERSION} AS build
WORKDIR /app

# See apps/backend/api/Dockerfile for the rationale — `bun build
# --minify` folds `process.env.NODE_ENV === 'production'` at build
# time, so NODE_ENV must be set in this stage (not just runtime).
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules

COPY package.json bun.lock tsconfig.json ./
COPY apps/backend/data-provider ./apps/backend/data-provider
COPY packages ./packages

RUN cd apps/backend/data-provider && bun run build

# ---------- runtime ----------
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

EXPOSE 8082

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl --fail --silent --show-error http://localhost:8082/health > /dev/null || exit 1

CMD ["/app/server"]
