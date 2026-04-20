# syntax=docker/dockerfile:1.7
#
# Multi-stage Bun build for scani-backend.
# Base: Debian (bookworm-slim) — not Alpine — so postgres.js native prepared-statement
# paths don't trip on musl.

# Bun 1.3.12 has a decorator-emission regression: its bundler emits
# `var _init = __decorate(...)` helpers that its own parser then rejects
# with `Cannot declare a var variable that shadows a let/const/class
# variable: '_init'` on `@Service()` classes (typedi DI). Pinned to 1.3.11
# until the upstream fix lands; floating `1.3` brought 1.3.12 in and
# crash-looped backend + worker on the 2026-04-19 stability deploy.
ARG BUN_VERSION=1.3.11

# ---------- deps ----------
FROM oven/bun:${BUN_VERSION} AS deps
WORKDIR /app

# Copy only manifest files first for max layer cache reuse. Every workspace
# declared in the root package.json must be present, or `bun install` fails
# with `Workspace not found`.
COPY package.json bun.lock ./
COPY apps/admin/package.json apps/admin/package.json
COPY apps/backend/package.json apps/backend/package.json
COPY apps/cron/package.json apps/cron/package.json
COPY apps/frontendV2/package.json apps/frontendV2/package.json
COPY apps/landing/package.json apps/landing/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/ai-providers/package.json packages/ai-providers/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/email/package.json packages/email/package.json
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
# the bundled backend dist, and packages/ (DI container + db schema live
# in @scani/domain and @scani/db and are resolved at runtime, not bundled
# into dist).
COPY --from=build --chown=bun:bun /app/node_modules /app/node_modules
COPY --from=build --chown=bun:bun /app/apps/backend/dist /app/apps/backend/dist
COPY --from=build --chown=bun:bun /app/apps/backend/package.json /app/apps/backend/package.json
COPY --from=build --chown=bun:bun /app/packages /app/packages
COPY --from=build --chown=bun:bun /app/package.json /app/package.json

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD bun -e "fetch('http://localhost:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["bun", "run", "apps/backend/dist/index.js"]
