#!/bin/sh
# Boot shim for the scani-worker container.
#
# With REDIS_EMBEDDED=1 (set in fly.toml for production) it first starts
# a redis-server next to the worker binary. This machine hosts the
# queue/rate-limiter/realtime Redis for the whole backend — api and
# data-provider reach it as scani-worker.internal:6379 over Fly 6PN
# private networking (the app has no public IP, so "bind everything" is
# 6PN-only). It replaced the metered Upstash database, whose idle BullMQ
# polling billed ~$40/mo on per-command pricing.
#
# The requirepass value is parsed out of REDIS_URL rather than shipped
# as a second secret, so producer and server can never disagree.
#
# Local dev / docker-compose leaves REDIS_EMBEDDED unset and keeps using
# the compose-provided Redis.
set -eu

if [ "${REDIS_EMBEDDED:-0}" = "1" ]; then
  REDIS_PASS=$(printf '%s' "${REDIS_URL:-}" | sed -nE 's|^rediss?://[^:/@]*:([^@]*)@.*$|\1|p')
  if [ -z "$REDIS_PASS" ]; then
    echo "REDIS_EMBEDDED=1 but REDIS_URL carries no password — refusing to start an unauthenticated Redis" >&2
    exit 1
  fi

  # /data is the Fly volume (see fly.toml [mounts]); first boot after a
  # volume is created leaves it root-owned.
  mkdir -p /data
  chown app:app /data

  cat > /tmp/redis-scani.conf <<EOF
bind * -::*
protected-mode no
port 6379
requirepass $REDIS_PASS
appendonly yes
dir /data
maxmemory 256mb
maxmemory-policy noeviction
EOF
  # Config contains the password.
  chown app:app /tmp/redis-scani.conf
  chmod 600 /tmp/redis-scani.conf

  setpriv --reuid app --regid app --init-groups redis-server /tmp/redis-scani.conf &
fi

exec setpriv --reuid app --regid app --init-groups /app/server
