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
COPY --parents apps/*/*/package.json packages/*/*/package.json ./

# Filter to worker's workspace dep graph only. Worker depends on
# @scani/providers-google-sheets (the pricing cron uses Google Sheets
# fallback).
RUN bun install --frozen-lockfile --filter @scani/worker

FROM oven/bun:${BUN_VERSION} AS build
WORKDIR /app

# See apps/backend/api/Dockerfile for the rationale — `bun build
# --minify` folds `process.env.NODE_ENV === 'production'` at build
# time, so NODE_ENV must be set in this stage (not just runtime).
ENV NODE_ENV=production

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
