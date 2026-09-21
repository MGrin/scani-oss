#!/bin/sh
# Stops the worker before the VM runs out of memory (SC-1269).
#
# The machine has no swap. On 2026-09-19 MemAvailable fell from ~600 MB to 0
# twice in an hour; the second time the kernel thrashed instead of OOM-killing,
# the VM stopped answering even `flyctl machine exec`, the embedded Redis went
# with it, and api /health/deep read 503 for 35 minutes while Fly reported the
# machine started and healthy. A Fly `[checks]` block would only have REPORTED
# that: checks never restart a machine. So the restart has to come from inside,
# while there is still memory to act with.
#
# Usage: memory-watchdog.sh <pid>. Watches <pid> until it exits. When
# MemAvailable stays under the floor for STRIKES consecutive reads it logs the
# reading and stops <pid> (TERM, then KILL); the entrypoint then exits non-zero
# and Fly restarts the machine. Every REPORT_EVERY reads it logs one memory line,
# so the next incident leaves evidence past Fly's 100-line log buffer.
#
# A hang with memory to spare is the other half: during that incident the
# embedded Redis stopped answering. With WATCHDOG_PING_CMD set (the entrypoint
# sets a `redis-cli ping` when this machine hosts Redis), the command runs every
# read. It arms on its first PONG, so a Redis still loading its AOF at boot
# cannot trip it, and PING_STRIKES consecutive misses stop <pid> the same way.
#
# The 09-19 incident could not say WHICH process grew: Fly keeps 100 log lines
# and they had rolled. With WATCHDOG_HISTORY_FILE set (the entrypoint points it
# at the persistent volume), one line of available memory and each watched
# process's RSS is appended every HISTORY_EVERY reads, rotated at
# HISTORY_MAX_KB, so it survives the restart the watchdog itself causes.
set -u

pid="$1"
meminfo="${WATCHDOG_MEMINFO:-/proc/meminfo}"
interval="${WATCHDOG_INTERVAL_S:-5}"
# 160, not the 96 it was: on 2026-09-21 a backfill chunk took the box from
# 240 MB to 0 between two reads, and at 0 this loop's own TERM/KILL could not
# run for about four minutes (SC-1283). The floor has to leave room to act in.
floor_mb="${WATCHDOG_MIN_AVAILABLE_MB:-160}"
strikes_needed="${WATCHDOG_STRIKES:-2}"
report_every="${WATCHDOG_REPORT_EVERY:-120}"
grace="${WATCHDOG_KILL_GRACE_S:-10}"
# The entrypoint reads this to exit non-zero: the worker's own SIGTERM handler
# shuts down cleanly and exits 0, and the machine's restart policy is
# on-failure, so without it a watchdog stop would leave the worker down.
marker="${WATCHDOG_MARKER:-/tmp/memory-watchdog.stopped}"
ping_cmd="${WATCHDOG_PING_CMD:-}"
ping_strikes_needed="${WATCHDOG_PING_STRIKES:-6}"
# An unarmed probe protects nothing, and a wrong password looks exactly like a
# Redis still loading, so after this many reads with no PONG it says so, and
# again every REPORT_EVERY reads until it arms.
ping_unarmed_warn="${WATCHDOG_PING_UNARMED_WARN:-60}"
history="${WATCHDOG_HISTORY_FILE:-}"
history_every="${WATCHDOG_HISTORY_EVERY:-12}"
history_max_kb="${WATCHDOG_HISTORY_MAX_KB:-1024}"
# Another process worth recording beside <pid>: the embedded Redis.
also_pid="${WATCHDOG_ALSO_PID:-}"

available_mb() {
  awk '/^MemAvailable:/ { printf "%d", $2 / 1024; found = 1 } END { if (!found) print "" }' "$meminfo" 2>/dev/null
}

rss_mb() {
  awk '/^VmRSS:/ { printf "%d", $2 / 1024 }' "/proc/${1:-$pid}/status" 2>/dev/null
}

record() {
  [ -n "$history" ] || return 0
  line="$(date -u +%Y-%m-%dT%H:%M:%SZ) available=${1}MB worker_rss=$(rss_mb)MB"
  [ -n "$also_pid" ] && line="$line other_rss=$(rss_mb "$also_pid")MB"
  echo "$line" >> "$history" 2>/dev/null || return 0
  size_kb=$(($(wc -c < "$history" 2>/dev/null || echo 0) / 1024))
  [ "$size_kb" -ge "$history_max_kb" ] && mv -f "$history" "$history.1" 2>/dev/null
  return 0
}

stop_worker() {
  echo "memory-watchdog: STOPPING worker pid $pid — $1 (SC-1269)" >&2
  [ -n "$history" ] && echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) STOPPING: $1" >> "$history" 2>/dev/null
  : > "$marker"
  kill -TERM "$pid" 2>/dev/null
  waited=0
  while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt "$grace" ]; do
    sleep 1
    waited=$((waited + 1))
  done
  kill -KILL "$pid" 2>/dev/null
  exit 0
}

strikes=0
tick=0
ping_armed=0
ping_misses=0
while kill -0 "$pid" 2>/dev/null; do
  avail="$(available_mb)"
  tick=$((tick + 1))
  if [ -n "$ping_cmd" ]; then
    if [ "$(sh -c "$ping_cmd" 2>/dev/null)" = "PONG" ]; then
      [ "$ping_armed" -eq 0 ] && echo "memory-watchdog: liveness ping armed"
      ping_armed=1
      ping_misses=0
    elif [ "$ping_armed" -eq 1 ]; then
      ping_misses=$((ping_misses + 1))
      if [ "$ping_misses" -ge "$ping_strikes_needed" ]; then
        stop_worker "liveness ping missed ${ping_misses} reads in a row"
      fi
    elif [ "$tick" -ge "$ping_unarmed_warn" ] && [ $(((tick - ping_unarmed_warn) % report_every)) -eq 0 ]; then
      echo "memory-watchdog: liveness ping NOT ARMED after ${tick} reads — no PONG yet (a wrong password reads the same as a Redis still loading), so a Redis hang is NOT being watched" >&2
    fi
  fi
  if [ -z "$avail" ]; then
    # Could not read memory: say so once per report period rather than act on it.
    [ $((tick % report_every)) -eq 1 ] && echo "memory-watchdog: MemAvailable unreadable from $meminfo; not acting" >&2
  else
    [ $(((tick - 1) % history_every)) -eq 0 ] && record "$avail"
    if [ $((tick % report_every)) -eq 1 ]; then
      echo "memory-watchdog: available=${avail}MB worker_rss=$(rss_mb)MB floor=${floor_mb}MB"
    fi
    if [ "$avail" -lt "$floor_mb" ]; then
      strikes=$((strikes + 1))
    else
      strikes=0
    fi
    if [ "$strikes" -ge "$strikes_needed" ]; then
      stop_worker "available=${avail}MB under ${floor_mb}MB for ${strikes} reads, worker_rss=$(rss_mb)MB"
    fi
  fi
  sleep "$interval"
done
