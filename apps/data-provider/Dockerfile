# syntax=docker/dockerfile:1.7
#
# Multi-stage Bun build for scani-data-provider.
# Base: Debian (bookworm-slim) — not Alpine — to keep parity with backend's
# build tooling. No postgres.js in this service today, but the same ioredis
# + @sentry/node stack benefits from the identical glibc environment.

# See backend Dockerfile for why 1.3.12 is pinned away.
ARG BUN_VERSION=1.3.11

# ---------- deps ----------
FROM oven/bun:${BUN_VERSION} AS deps
WORKDIR /app

# Copy only manifest files first for max layer cache reuse. Every workspace
# declared in the root package.json must be present.
COPY package.json bun.lock ./
COPY apps/admin/package.json apps/admin/package.json
COPY apps/backend/package.json apps/backend/package.json
COPY apps/cloud-frontend/package.json apps/cloud-frontend/package.json
COPY apps/cron/package.json apps/cron/package.json
COPY apps/data-provider/package.json apps/data-provider/package.json
COPY apps/frontendV2/package.json apps/frontendV2/package.json
COPY apps/landing/package.json apps/landing/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/ai-providers/package.json packages/ai-providers/package.json
COPY packages/cloud-client/package.json packages/cloud-client/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/email/package.json packages/email/package.json
COPY packages/frontend-shared/package.json packages/frontend-shared/package.json
COPY packages/integrations/package.json packages/integrations/package.json
COPY packages/logging/package.json packages/logging/package.json
COPY packages/pricing-providers/package.json packages/pricing-providers/package.json
COPY packages/queue/package.json packages/queue/package.json
COPY packages/rate-limiter/package.json packages/rate-limiter/package.json
COPY packages/realtime/package.json packages/realtime/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/storage/package.json packages/storage/package.json

RUN bun install --frozen-lockfile

# ---------- build ----------
FROM oven/bun:${BUN_VERSION} AS build
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules

COPY package.json bun.lock tsconfig.json ./
COPY apps/data-provider ./apps/data-provider
COPY packages ./packages

RUN cd apps/data-provider && bun run build

# ---------- runtime ----------
FROM oven/bun:${BUN_VERSION}-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=8082 \
    HOST=0.0.0.0

USER bun

COPY --from=build --chown=bun:bun /app/node_modules /app/node_modules
COPY --from=build --chown=bun:bun /app/apps/data-provider/dist /app/apps/data-provider/dist
COPY --from=build --chown=bun:bun /app/apps/data-provider/package.json /app/apps/data-provider/package.json
COPY --from=build --chown=bun:bun /app/packages /app/packages
COPY --from=build --chown=bun:bun /app/package.json /app/package.json

EXPOSE 8082

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD bun -e "fetch('http://localhost:8082/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["bun", "run", "apps/data-provider/dist/index.js"]
