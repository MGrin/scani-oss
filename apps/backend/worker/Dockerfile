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
RUN bun install --frozen-lockfile --filter @scani/worker --linker=hoisted

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

FROM debian:bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --shell /usr/sbin/nologin --uid 1001 app
USER app

COPY --from=build --chown=app:app /app/apps/backend/worker/dist/server /app/server

CMD ["/app/server"]
