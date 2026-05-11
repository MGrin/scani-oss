import { JOB_NAMES, REPEATABLE_SCHEDULES } from '@scani/queue/queue-names';

/**
 * Read-only view over the repeatable-job registry. The list itself lives
 * in `@scani/queue` and is shared with the worker boot code, so the
 * admin can't drift from production — adding a schedule on the worker
 * adds a row here automatically.
 *
 * `lastRun` is intentionally absent. BullMQ's internal scheduler keeps
 * its bookkeeping under keys (`bull:scani-jobs:repeat:*`) that don't
 * expose run history. Surfacing real last-run + history needs worker-
 * side instrumentation (write a `bull:scani-jobs:schedules:<name>` hash
 * on every fire), which is a separate change. For now the page shows
 * cron pattern + a human-readable cadence + a computed next-run.
 */

export interface ScheduleEntry {
  name: string;
  /** Standard 5-field cron expression in UTC. */
  pattern: string;
  /** Plain-English cadence rendered next to the cron pattern. */
  cadence: string;
  /** Computed next-fire timestamp (UTC ISO), or `null` if the pattern doesn't parse. */
  nextRunAt: string | null;
  /** Short operator-facing description of what the job does. */
  description: string;
}

const DESCRIPTIONS: Record<string, string> = {
  [JOB_NAMES.pricing]: 'Refresh current spot prices for every active token + base currency.',
  [JOB_NAMES.walletBalances]:
    'Sync blockchain wallet balances across BTC / ETH / SOL / TRON / TON.',
  [JOB_NAMES.exchangeBalances]: 'Sync CEX + brokerage balances for every active credential.',
  [JOB_NAMES.apyPayouts]:
    'Apply staking / earn / interest accruals to balances at the close of UTC day.',
  [JOB_NAMES.reconcilePendingCredentials]:
    'Sweep credentials stuck in `pending_enqueue` and re-enqueue the import job.',
  [JOB_NAMES.reconcileOrphanedUserJobs]:
    'Mark `user_jobs` rows that never got a corresponding BullMQ job as `failed`.',
};

export function getScheduledJobs(): ScheduleEntry[] {
  const now = new Date();
  return REPEATABLE_SCHEDULES.map((s) => {
    const next = nextCronFire(s.pattern, now);
    return {
      name: s.name,
      pattern: s.pattern,
      cadence: describeCron(s.pattern),
      nextRunAt: next ? next.toISOString() : null,
      description: DESCRIPTIONS[s.name] ?? 'No description registered.',
    };
  });
}

/**
 * Render a cron pattern in plain English for the handful of shapes we
 * actually use. Falls back to the raw pattern for anything unknown,
 * which is fine — the cron itself is shown next to it.
 */
function describeCron(pattern: string): string {
  switch (pattern) {
    case '* * * * *':
      return 'every minute';
    case '0 * * * *':
      return 'every hour on the hour';
    case '0 0 * * *':
      return 'daily at 00:00 UTC';
    case '0 12 * * *':
      return 'daily at 12:00 UTC';
    case '0 0 * * 0':
      return 'weekly Sunday 00:00 UTC';
    default:
      return pattern;
  }
}

/**
 * Tiny cron next-tick computer covering the 5-field UTC patterns we use
 * (`minute hour day-of-month month day-of-week`). Each field accepts
 * `*` or a single integer; ranges + lists + steps fall through to
 * `null`. The fallback is acceptable because the UI shows the raw
 * pattern alongside the computed time.
 */
function nextCronFire(pattern: string, from: Date): Date | null {
  const parts = pattern.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const matchers = parts.map(parseField);
  if (matchers.some((m) => m === null)) return null;
  const [m, h, dom, mo, dow] = matchers as Array<(n: number) => boolean>;

  const t = new Date(from.getTime());
  t.setUTCSeconds(0, 0);
  t.setUTCMinutes(t.getUTCMinutes() + 1);

  // 366d * 24h * 60m is the worst-case for a yearly schedule, but
  // anything we ship today resolves in < 24h. Hard-cap so a malformed
  // pattern can't spin forever.
  for (let i = 0; i < 366 * 24 * 60; i++) {
    if (
      m(t.getUTCMinutes()) &&
      h(t.getUTCHours()) &&
      dom(t.getUTCDate()) &&
      mo(t.getUTCMonth() + 1) &&
      dow(t.getUTCDay())
    ) {
      return t;
    }
    t.setUTCMinutes(t.getUTCMinutes() + 1);
  }
  return null;
}

function parseField(spec: string): ((n: number) => boolean) | null {
  if (spec === '*') return () => true;
  const n = Number.parseInt(spec, 10);
  if (!Number.isFinite(n)) return null;
  return (x) => x === n;
}
