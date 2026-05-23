# syntax=docker/dockerfile:1.7-labs
#
# Multi-stage Bun build → nginx static-serve for the frontend SPA.
# Build stage compiles the Vite bundle from the monorepo (build context
# must be the repo root); runtime is nginx:alpine serving the bundle +
# reverse-proxying /api to a backend container reachable as
# ${API_UPSTREAM} (defaults to http://api:3001 — matches the
# docker-compose.prod.yml service name).

ARG BUN_VERSION=1.3.13
ARG NGINX_VERSION=1.27-alpine

# ---------- deps + build ----------
FROM oven/bun:${BUN_VERSION} AS build
WORKDIR /app

# `--parents` preserves directory structure under the glob so new
# workspaces under `apps/*/*/` or `packages/*/*/` are picked up
# automatically.
COPY package.json bun.lock ./
COPY --parents apps/*/*/package.json packages/*/*/package.json ./

# Install only the frontend workspace's dep graph. Filters out the
# entire backend tree + every provider adapter, which keeps the build
# stage small (frontend deps are roughly React + Vite + shadcn + tRPC
# client; backend deps add ~hundreds of MB).
RUN bun install --frozen-lockfile --filter @scani/frontend-v2

# Source after deps for layer caching.
COPY . .

# VITE_* values are baked into the bundle at build time. Surface each
# as an ARG so the workflow / `docker build` invocation can override.
ARG VITE_API_URL=http://localhost:3001
ARG VITE_SENTRY_DSN=
ARG VITE_SENTRY_ENABLED=false
ENV VITE_API_URL=${VITE_API_URL} \
    VITE_SENTRY_DSN=${VITE_SENTRY_DSN} \
    VITE_SENTRY_ENABLED=${VITE_SENTRY_ENABLED}

WORKDIR /app/apps/frontend/app
RUN bun run build

# ---------- runtime ----------
FROM nginx:${NGINX_VERSION} AS runtime

# Default upstream points at the `api` service in docker-compose.prod.yml.
# Override at run-time with `-e API_UPSTREAM=https://your-api.example.com`.
ENV API_UPSTREAM=http://api:3001

# Static assets from the Vite build.
COPY --from=build /app/apps/frontend/app/dist /usr/share/nginx/html

# The nginx:alpine official image runs every file under
# `/etc/nginx/templates/` through `envsubst` at container start (see
# `/docker-entrypoint.d/20-envsubst-on-templates.sh`). Naming the
# template `default.conf.template` means it lands at
# `/etc/nginx/conf.d/default.conf` with `${API_UPSTREAM}` expanded — no
# custom entrypoint needed.
COPY apps/frontend/app/nginx.conf.template /etc/nginx/templates/default.conf.template

EXPOSE 80

# Healthcheck hits the SPA index. nginx returns 200 for the root if the
# build succeeded.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q --spider http://localhost/ || exit 1
