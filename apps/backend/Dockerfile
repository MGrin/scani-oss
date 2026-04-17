# syntax=docker/dockerfile:1.7
#
# Multi-stage Bun build for scani-backend.
# Base: Debian (bookworm-slim) — not Alpine — so postgres.js native prepared-statement
# paths don't trip on musl.

ARG BUN_VERSION=1.3

# ---------- deps ----------
FROM oven/bun:${BUN_VERSION} AS deps
WORKDIR /app

# Copy only manifest files first for max layer cache reuse.
COPY package.json bun.lock ./
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

# ---------- build ----------
FROM oven/bun:${BUN_VERSION} AS build
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules

COPY package.json bun.lock tsconfig.json ./
COPY apps/backend ./apps/backend
COPY packages ./packages

RUN cd apps/backend && bun run build

# ---------- runtime ----------
FROM oven/bun:${BUN_VERSION}-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0

# Non-root user (the oven/bun image already ships a `bun` user).
USER bun

# Runtime needs: workspace node_modules (postgres.js, elysia, etc.),
# the bundled backend dist, and packages/core (DI container + db schema live
# here and are resolved at runtime, not bundled into dist).
COPY --from=build --chown=bun:bun /app/node_modules /app/node_modules
COPY --from=build --chown=bun:bun /app/apps/backend/dist /app/apps/backend/dist
COPY --from=build --chown=bun:bun /app/apps/backend/package.json /app/apps/backend/package.json
COPY --from=build --chown=bun:bun /app/packages /app/packages
COPY --from=build --chown=bun:bun /app/package.json /app/package.json

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://localhost:8080/health >/dev/null 2>&1 || exit 1

CMD ["bun", "run", "apps/backend/dist/index.js"]
