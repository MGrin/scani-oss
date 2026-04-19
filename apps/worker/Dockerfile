# syntax=docker/dockerfile:1.7
#
# Multi-stage Bun image for scani-worker. Identical pattern to
# apps/backend/Dockerfile so a given commit produces interchangeable images.

ARG BUN_VERSION=1.3

FROM oven/bun:${BUN_VERSION} AS deps
WORKDIR /app

COPY package.json bun.lock ./
# Every workspace declared in the root package.json must be present, or
# `bun install` fails with `Workspace not found`.
COPY apps/admin/package.json apps/admin/package.json
COPY apps/backend/package.json apps/backend/package.json
COPY apps/cron/package.json apps/cron/package.json
COPY apps/frontendV2/package.json apps/frontendV2/package.json
COPY apps/landing/package.json apps/landing/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/integrations/package.json packages/integrations/package.json
COPY packages/rate-limiter/package.json packages/rate-limiter/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN bun install --frozen-lockfile

FROM oven/bun:${BUN_VERSION} AS build
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules

COPY package.json bun.lock tsconfig.json ./
COPY apps/backend ./apps/backend
COPY apps/cron ./apps/cron
COPY apps/worker ./apps/worker
COPY packages ./packages

RUN cd apps/worker && bun run build

FROM oven/bun:${BUN_VERSION}-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production

USER bun

COPY --from=build --chown=bun:bun /app/node_modules /app/node_modules
COPY --from=build --chown=bun:bun /app/apps/worker/dist /app/apps/worker/dist
COPY --from=build --chown=bun:bun /app/apps/worker/package.json /app/apps/worker/package.json
COPY --from=build --chown=bun:bun /app/apps/cron /app/apps/cron
COPY --from=build --chown=bun:bun /app/packages /app/packages
COPY --from=build --chown=bun:bun /app/package.json /app/package.json

# No HTTP port — worker is a background process. No HEALTHCHECK either;
# Fly observes the machine's exit status, and BullMQ itself is the
# liveness signal (jobs keep processing).

CMD ["bun", "--smol", "run", "apps/worker/dist/index.js"]
