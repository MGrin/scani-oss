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
set -u

pid="$1"
meminfo="${WATCHDOG_MEMINFO:-/proc/meminfo}"
interval="${WATCHDOG_INTERVAL_S:-5}"
floor_mb="${WATCHDOG_MIN_AVAILABLE_MB:-96}"
strikes_needed="${WATCHDOG_STRIKES:-2}"
report_every="${WATCHDOG_REPORT_EVERY:-120}"
grace="${WATCHDOG_KILL_GRACE_S:-10}"
# The entrypoint reads this to exit non-zero: the worker's own SIGTERM handler
# shuts down cleanly and exits 0, and the machine's restart policy is
# on-failure, so without it a watchdog stop would leave the worker down.
marker="${WATCHDOG_MARKER:-/tmp/memory-watchdog.stopped}"

available_mb() {
  awk '/^MemAvailable:/ { printf "%d", $2 / 1024; found = 1 } END { if (!found) print "" }' "$meminfo" 2>/dev/null
}

rss_mb() {
  awk '/^VmRSS:/ { printf "%d", $2 / 1024 }' "/proc/$pid/status" 2>/dev/null
}

strikes=0
tick=0
while kill -0 "$pid" 2>/dev/null; do
  avail="$(available_mb)"
  tick=$((tick + 1))
  if [ -z "$avail" ]; then
    # Could not read memory: say so once per report period rather than act on it.
    [ $((tick % report_every)) -eq 1 ] && echo "memory-watchdog: MemAvailable unreadable from $meminfo; not acting" >&2
  else
    if [ $((tick % report_every)) -eq 1 ]; then
      echo "memory-watchdog: available=${avail}MB worker_rss=$(rss_mb)MB floor=${floor_mb}MB"
    fi
    if [ "$avail" -lt "$floor_mb" ]; then
      strikes=$((strikes + 1))
    else
      strikes=0
    fi
    if [ "$strikes" -ge "$strikes_needed" ]; then
      echo "memory-watchdog: STOPPING worker pid $pid — available=${avail}MB under ${floor_mb}MB for ${strikes} reads, worker_rss=$(rss_mb)MB (SC-1269)" >&2
      : > "$marker"
      kill -TERM "$pid" 2>/dev/null
      waited=0
      while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt "$grace" ]; do
        sleep 1
        waited=$((waited + 1))
      done
      kill -KILL "$pid" 2>/dev/null
      exit 0
    fi
  fi
  sleep "$interval"
done
