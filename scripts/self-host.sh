#!/usr/bin/env bash
#
# One command to a running self-hosted Scani, from an empty directory.
#
#   curl -fsSL https://raw.githubusercontent.com/MGrin/scani-oss/main/scripts/self-host.sh | bash
#
# or, from a checkout:
#
#   ./scripts/self-host.sh
#
# Why this exists rather than a docs page telling you to copy `.env.example`:
# that path is broken and has been for a while. `.env.example` ships DEV
# values — `ENCRYPTION_KEY=0123456789abcdef0123456789abcdef` is published in
# a public repo, so a self-hoster who copies it stores every exchange API key
# they own under a key a stranger can read. And it does not even boot:
# `LOG_ID_PEPPER` is deliberately empty there (dev logs raw IDs on purpose),
# so `docker compose -f docker-compose.prod.yml up` refuses at interpolation
# time with a message about a variable most people have never heard of.
#
# So the fix is not to weaken the compose file's `${VAR:?...}` guards — those
# are the early, legible failure for anyone who skips this script. The fix is
# to generate the values. Everything below is `openssl rand -hex 32`: 64 hex
# chars, which clears the >=32 floor everywhere and, for ENCRYPTION_KEY,
# hits @scani/security's hex fast path so credential encryption skips scrypt
# (see packages/infra/security/src/encryption.ts).
#
# GitHub Actions is billing-blocked on the private repo (SC-128, SC-433), so
# nothing here may depend on a workflow firing. It does not: this is the same
# shape as scripts/deploy-local.sh — the automated path reproduced so a human
# can run it from a laptop.
#
# Env overrides:
#   SCANI_REF=main            git ref of scani-oss to fetch the compose file from
#   SCANI_IMAGE_TAG=latest    image tag to run (pin this for a reproducible box)
#   SCANI_PORT=8080           host port the SPA is served on
#   SCANI_MAIL_PORT=8026      host port for the bundled mail catcher (loopback only)
#   SCANI_SKIP_UP=1           write .env and stop — for inspecting before booting
#   SCANI_RESET=1             DELETE this project's data volumes first (see below)
#
set -euo pipefail

SCANI_REF="${SCANI_REF:-main}"
SCANI_IMAGE_TAG="${SCANI_IMAGE_TAG:-latest}"
SCANI_PORT="${SCANI_PORT:-8080}"
SCANI_MAIL_PORT="${SCANI_MAIL_PORT:-8026}"
RAW_BASE="https://raw.githubusercontent.com/MGrin/scani-oss/${SCANI_REF}"
COMPOSE_FILE="docker-compose.prod.yml"

log()  { printf '\033[36m▸\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
die()  { printf '\033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- preflight

command -v docker >/dev/null 2>&1 \
  || die "docker not found. Install Docker Desktop, OrbStack, or docker-ce, then re-run."
docker compose version >/dev/null 2>&1 \
  || die "the docker compose plugin is missing. Scani needs Compose v2 (\`docker compose\`, not \`docker-compose\`)."
docker info >/dev/null 2>&1 \
  || die "the Docker daemon is not reachable. Start Docker and re-run."
command -v openssl >/dev/null 2>&1 \
  || die "openssl not found. It generates this install's secrets; there is no safe fallback."
command -v curl >/dev/null 2>&1 \
  || die "curl not found."

ok "docker $(docker version --format '{{.Server.Version}}'), compose $(docker compose version --short)"

# -------------------------------------------------- a previous install's state
#
# Compose names its volumes after the PROJECT, and the project name comes from
# the directory's name rather than from anything inside it. So `rm -rf` on the
# install directory — the obvious way to start over after a failed first run —
# leaves postgres-data behind, still holding the password from the .env that was
# deleted with it. The next run generates fresh secrets and the migration is the
# first thing to meet the mismatch:
#
#   G1: password authentication failed for user "scani"   code: 28P01
#
# That names neither volumes nor secrets, and nobody derives the recovery from
# it. Any ordinary first failure — a taken port, a Ctrl-C, a flaky pull — puts a
# person here, because the recovery they reach for is to run it again (SC-479).
#
# So the check happens before this script writes anything at all: a refusal
# leaves the directory exactly as it found it.

compose_project() {
  # Ask compose rather than reimplementing how it derives a project name from a
  # directory (lowercasing, character substitution, COMPOSE_PROJECT_NAME, the
  # `.env` override). A throwaway one-service file on stdin resolves its project
  # directory to the cwd, the same as the real file would — and, unlike the real
  # file, it interpolates with no .env present.
  printf 'services:\n  noop:\n    image: alpine\n' \
    | docker compose -f - config 2>/dev/null \
    | sed -n 's/^name: *//p' | head -1 | tr -d '"'
}

PROJECT="$(compose_project)"
EXISTING_VOLUMES=""
for volume in postgres-data redis-data minio-data; do
  if [ -n "$PROJECT" ] && docker volume inspect "${PROJECT}_${volume}" >/dev/null 2>&1; then
    EXISTING_VOLUMES="${EXISTING_VOLUMES}${EXISTING_VOLUMES:+ }${PROJECT}_${volume}"
  fi
done

if [ -n "$EXISTING_VOLUMES" ] && [ "${SCANI_RESET:-0}" = "1" ]; then
  log "SCANI_RESET=1 — deleting this project's containers and data volumes"
  STALE="$(docker ps -aq --filter "label=com.docker.compose.project=${PROJECT}")"
  if [ -n "$STALE" ]; then
    # Unquoted on purpose: one container id per argument.
    # shellcheck disable=SC2086
    docker rm -f $STALE >/dev/null
  fi
  # shellcheck disable=SC2086
  docker volume rm $EXISTING_VOLUMES >/dev/null
  ok "deleted ${EXISTING_VOLUMES}"
  EXISTING_VOLUMES=""
fi

if [ -n "$EXISTING_VOLUMES" ] && [ ! -f .env ]; then
  die "a previous install's data is still on this machine, and the secrets that unlock it are not.

  These Docker volumes are left over from an earlier run in this directory:

$(printf '%s' "$EXISTING_VOLUMES" | tr ' ' '\n' | sed 's/^/      /')

  Compose named them after the project (${PROJECT}), not after the directory,
  so deleting the directory did not remove them. The Postgres inside still
  wants the password from that run's .env — and this directory has no .env
  now. Generating a fresh one would produce different secrets, and the
  migration would fail with \`password authentication failed for user
  \"scani\"\`, which is the same dead end by a longer route.

  To KEEP that data: put the .env from that run back in this directory and run
  this again. Nothing is regenerated and the install converges.

  To THROW IT AWAY and install clean, re-run with SCANI_RESET=1, or by hand:

      docker rm -f \$(docker ps -aq --filter label=com.docker.compose.project=${PROJECT})
      docker volume rm ${EXISTING_VOLUMES}"
fi

# ------------------------------------------------------------- compose file
#
# Run from a checkout and the file is already here; run from an empty
# directory (the curl-pipe path) and we fetch it. Never overwrite: an
# operator who edited the compose file to point at managed Postgres has
# put real deployment decisions in it.

if [ -f "$COMPOSE_FILE" ]; then
  ok "$COMPOSE_FILE already here — using it as-is"
else
  log "fetching $COMPOSE_FILE from scani-oss@${SCANI_REF}"
  curl -fsSL -o "$COMPOSE_FILE" "${RAW_BASE}/${COMPOSE_FILE}" \
    || die "could not fetch ${RAW_BASE}/${COMPOSE_FILE}"
  ok "$COMPOSE_FILE"
fi

# --------------------------------------------------------------------- .env
#
# Generated once and never again. Regenerating ENCRYPTION_KEY over a
# database that already holds encrypted integration credentials does not
# fail loudly — it makes every stored credential undecryptable, and the
# symptom is imports quietly returning nothing days later. So an existing
# .env is left strictly alone, including when it is incomplete: a wrong
# key is worse than a missing one.

gen() { openssl rand -hex 32; }

if [ -f .env ]; then
  ok ".env already here — reusing this install's secrets, file untouched"
else
  log "generating .env with fresh secrets"
  DATA_PROVIDER_KEY="$(gen)"
  # Narrow the umask only while the file is being created, so there is no
  # window in which .env is world-readable, and put it back afterwards.
  PRIOR_UMASK="$(umask)"
  umask 077
  cat > .env <<ENV
# Generated by scripts/self-host.sh. These are THIS install's secrets.
# Back this file up with your database — the two are useless apart.

SCANI_IMAGE_TAG=${SCANI_IMAGE_TAG}
FRONTEND_PORT=${SCANI_PORT}
MAILPIT_UI_PORT=${SCANI_MAIL_PORT}

# Public URLs. nginx inside the frontend-app container reverse-proxies
# /api to the api service, so both live on the same origin. Put a
# TLS-terminating proxy in front and change both to your https hostname.
#
# BACKEND_URL must carry NO path, even though the api is reached under
# /api from outside. Better-Auth derives its route basePath from this
# URL's path, so a trailing /api moves every auth route to somewhere the
# api never serves: /api/auth/ok answers 404, and the only symptom a
# self-hoster sees is that signing in does nothing (SC-453).
FRONTEND_URL=http://localhost:${SCANI_PORT}
BACKEND_URL=http://localhost:${SCANI_PORT}

# Session cookie signing. Rotating this logs everyone out.
BETTER_AUTH_SECRET=$(gen)

# AES-256-GCM key for integration credentials at rest. 64 hex chars, so
# it is used as the key directly rather than stretched with scrypt.
# ROTATING THIS MAKES EVERY STORED CREDENTIAL UNREADABLE.
ENCRYPTION_KEY=$(gen)

# HMAC for admin -> api job actions.
JOBS_HMAC_SECRET=$(gen)

# Pepper that one-way hashes user/account IDs in logs.
LOG_ID_PEPPER=$(gen)

# Shared bearer between api/worker and the bundled data-provider.
# These two MUST stay equal.
DATA_PROVIDER_API_KEY=${DATA_PROVIDER_KEY}
SCANI_CLOUD_API_KEY=${DATA_PROVIDER_KEY}

# Bundled Postgres / MinIO. Change these before exposing either port.
POSTGRES_PASSWORD=$(gen)
DATABASE_URL=postgres://scani:__PG_PASSWORD__@postgres:5432/scani?sslmode=disable
MINIO_ROOT_USER=scani
MINIO_ROOT_PASSWORD=$(gen)
S3_ACCESS_KEY_ID=scani
S3_SECRET_ACCESS_KEY=__MINIO_PASSWORD__

# Optional provider keys — Scani runs without them, with less data.
# https://docs.scani.xyz/self-hosting/tier1/optional-keys/
OPENAI_API_KEY=
COINGECKO_API_KEY=
FINNHUB_API_KEY=
ETHERSCAN_API_KEY=
HELIUS_API_KEY=

# Mail. Sign-in is passwordless — a code is emailed — so with no mail
# transport there is no way to finish a first login. The stack therefore
# bundles Mailpit and points at it, and you read your own code at
# http://localhost:8026. Point SMTP_URL at a real server (and drop the
# mailpit service) before anyone but you uses this instance.
SMTP_URL=smtp://mailpit:1025
SMTP_FROM=no-reply@scani.local

LOG_LEVEL=info
ENV

  # DATABASE_URL and S3_SECRET_ACCESS_KEY have to carry the same values the
  # postgres/minio services are started with. Writing the placeholders above
  # and substituting here keeps each secret generated exactly once, so the
  # file cannot ship a connection string that disagrees with the service it
  # points at.
  PG_PASSWORD="$(grep -m1 '^POSTGRES_PASSWORD=' .env | cut -d= -f2)"
  MINIO_PASSWORD="$(grep -m1 '^MINIO_ROOT_PASSWORD=' .env | cut -d= -f2)"
  # `sed -i` is not portable (BSD wants an argument, GNU does not).
  TMP_ENV="$(mktemp)"
  sed -e "s/__PG_PASSWORD__/${PG_PASSWORD}/" -e "s/__MINIO_PASSWORD__/${MINIO_PASSWORD}/" .env > "$TMP_ENV"
  cat "$TMP_ENV" > .env
  rm -f "$TMP_ENV"
  chmod 600 .env
  umask "$PRIOR_UMASK"
  ok ".env written (mode 600, $(grep -c '^[A-Z]' .env) variables)"
fi

if [ "${SCANI_SKIP_UP:-0}" = "1" ]; then
  ok "SCANI_SKIP_UP=1 — stopping before boot. Review .env, then: docker compose -f $COMPOSE_FILE up -d"
  exit 0
fi

# --------------------------------------------------------------------- boot

compose() { docker compose -f "$COMPOSE_FILE" "$@"; }

log "pulling images (tag: ${SCANI_IMAGE_TAG})"
compose pull --quiet </dev/null

# Migrations are a separate, explicit step in docker-compose.prod.yml — the
# app never rewrites its own schema as a startup side-effect. `--allow-remote
# postgres` is passed here rather than left to the compose file's `command:`
# so this works against any published revision of that file, including ones
# predating that line.
#
# `</dev/null` is load-bearing on the curl-pipe path and cost an hour to find:
# when this script is piped to bash, the script text IS stdin, and
# `docker compose run` attaches stdin to the container and consumes what is
# left of it. The migration succeeds, prints its own success, and the script
# then simply ends — no error, no boot, one healthy postgres and nothing
# else. A silent partial success is the failure mode to fear here, so every
# docker call below that could touch stdin gets the redirect.
log "applying database migrations"
compose --profile migrate run --rm --no-TTY migrate /app/migrate --allow-remote postgres </dev/null

log "starting services"
compose up -d </dev/null

# `up -d` returns as soon as containers are created, which is well before the
# api can answer. Wait on the thing a person actually wants — an HTTP 200
# from the SPA's origin — rather than on container state, which is green
# while nginx is still booting.
log "waiting for http://localhost:${SCANI_PORT} to answer"
deadline=$(( $(date +%s) + 180 ))
until curl -fsS -o /dev/null "http://localhost:${SCANI_PORT}/healthz" 2>/dev/null; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    compose ps
    die "gave up after 180s. \`docker compose -f $COMPOSE_FILE logs api worker\` will say why."
  fi
  sleep 3
done

ok "Scani is running at http://localhost:${SCANI_PORT}"
echo
echo "  Sign up:   http://localhost:${SCANI_PORT}"
echo "  Your code: http://localhost:${SCANI_MAIL_PORT}   (sign-in is passwordless — read the code here)"
echo "  Logs:      docker compose -f $COMPOSE_FILE logs -f api worker"
echo "  Stop:      docker compose -f $COMPOSE_FILE down"
echo "  Upgrade:   see https://docs.scani.xyz/self-hosting/tier1/upgrades/"
echo
echo "  Your secrets are in ./.env — back it up with your database."
