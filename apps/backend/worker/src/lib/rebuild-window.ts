// Safety pad on top of the gap-since-last-rollup, so a fresh
// transaction whose date barely predates the last rollup row still
// gets re-priced.
export const LOOKBACK_SAFETY_PAD_DAYS = 7;
// Ceiling for a window sized from the oldest row an import wrote (SC-1459):
// the schema's own maximum, so any real history is reached. Memory does not
// grow with the window, because the rollup walks it in 30-day chunks (SC-1283):
// mgrin's full 1853-day rebuild peaked at 315 MB, SC-1440's at 440 MB, both
// under the worker's 560 MB watchdog.
const LOOKBACK_MAX_DAYS = 365 * 100;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The rebuild must reach the oldest row the import wrote, whatever the
 * snapshot's age says (SC-1459): a backdated transaction or opening balance
 * makes every day from its date to today stale.
 */
export function widenToEarliestWrite(
  snapshotWindow: number,
  earliestWrittenAt: string | null,
  now: Date = new Date()
): number {
  if (!earliestWrittenAt) return snapshotWindow;
  const written = new Date(earliestWrittenAt);
  if (Number.isNaN(written.getTime())) return snapshotWindow;
  const reach = Math.ceil((now.getTime() - written.getTime()) / DAY_MS) + LOOKBACK_SAFETY_PAD_DAYS;
  return Math.min(Math.max(snapshotWindow, reach), LOOKBACK_MAX_DAYS);
}
