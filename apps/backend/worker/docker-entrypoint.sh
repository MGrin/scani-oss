#!/bin/sh
# Boot shim for the scani-worker container.
#
# With REDIS_EMBEDDED=1 (set in fly.toml for production) it first starts
# a redis-server next to the worker binary. This machine hosts the
# rate-limiter/realtime Redis for the whole backend — api and
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
rename-command FLUSHALL ""
rename-command FLUSHDB ""
rename-command CONFIG ""
rename-command DEBUG ""
rename-command MODULE ""
rename-command KEYS ""
rename-command SHUTDOWN ""
rename-command REPLICAOF ""
rename-command SLAVEOF ""
rename-command MIGRATE ""
rename-command SAVE ""
rename-command BGSAVE ""
rename-command BGREWRITEAOF ""
rename-command MONITOR ""
rename-command SYNC ""
rename-command PSYNC ""
rename-command ACL ""
rename-command FAILOVER ""
EOF
  # Config contains the password.
  chown app:app /tmp/redis-scani.conf
  chmod 600 /tmp/redis-scani.conf

  setpriv --reuid app --regid app --init-groups redis-server /tmp/redis-scani.conf &
  redis_pid=$!
fi

# Not `exec`: the memory watchdog needs the server's pid, and this shell has to
# outlive the server to hand Fly a non-zero exit when the watchdog stops it
# (SC-1269). A stop signal is forwarded so a deploy still shuts down cleanly.
# `set -e` would end this shell at the first non-zero `wait`, before the real
# status is collected or the watchdog's marker is read.
set +e
rm -f /tmp/memory-watchdog.stopped
setpriv --reuid app --regid app --init-groups /app/server &
server=$!
trap 'kill -TERM "$server" 2>/dev/null' TERM INT
# The embedded Redis is part of what a hang takes down, so it is the liveness
# probe; REDISCLI_AUTH keeps the password out of the process list.
if [ "${REDIS_EMBEDDED:-0}" = "1" ]; then
  # /data is the persistent volume, so the memory history outlives a restart.
  REDISCLI_AUTH="$REDIS_PASS" \
    WATCHDOG_PING_CMD='timeout 3 redis-cli -h 127.0.0.1 -p 6379 ping' \
    WATCHDOG_HISTORY_FILE=/data/watchdog-history.log \
    WATCHDOG_ALSO_PID="$redis_pid" \
    /app/memory-watchdog.sh "$server" &
else
  /app/memory-watchdog.sh "$server" &
fi
wait "$server"
rc=$?
# Over 128 is either the server's own signal death or a trapped signal cutting
# `wait` short; a second `wait` collects the real status, and answers 127 when
# there is nothing left to collect.
if [ "$rc" -gt 128 ]; then
  wait "$server"
  again=$?
  [ "$again" -ne 127 ] && rc=$again
fi
# The worker exits 0 on SIGTERM and the restart policy is on-failure, so a
# watchdog stop must not look like a clean exit.
if [ -e /tmp/memory-watchdog.stopped ]; then
  exit 70
fi
exit "$rc"
