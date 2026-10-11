import { describe, expect, test } from 'bun:test';
import { SCHEDULED_JOB_DESCRIPTORS } from '../../src/scheduled-jobs';

/**
 * Every :00 fired the four hourly jobs and the four quarter-hour jobs together,
 * eight against a cap of four scheduled slots, so the quarter-hour probes
 * queued behind the syncs: 4-10s in Sentry for work their heartbeat times at
 * 8 ms (SC-1601, SC-1598 item 7). They now run two minutes past each quarter,
 * as the steps of one group (SC-1688), so the database still idles between
 * bursts (`procedure-call-recorder.ts`).
 */

const minutesOf = (cron: string) => cron.split(' ')[0] ?? '';
const firesAtMinuteZero = (cron: string) => {
  const minute = minutesOf(cron);
  return (
    minute === '0' || minute === '*' || minute.startsWith('*/') || minute.split(',').includes('0')
  );
};
const stepsOf = (name: string) => {
  const group = SCHEDULED_JOB_DESCRIPTORS.find((d) => d.name === name);
  return group && 'steps' in group ? group.steps.map((s) => s.name) : undefined;
};

describe('the top of the hour', () => {
  test('the quarter-hour jobs run at :02, :17, :32 and :47, as steps of housekeeping (SC-1688)', () => {
    expect(SCHEDULED_JOB_DESCRIPTORS.find((d) => d.name === 'housekeeping')?.cron).toBe(
      '2-59/15 * * * *'
    );
    expect(stepsOf('housekeeping')?.sort()).toEqual(
      [
        'dlq-depth-probe',
        'job-heartbeat-probe',
        'reconcile-orphaned-user-jobs',
        'reconcile-pending-credentials',
      ].sort()
    );
  });

  test('only the hourly group fires at :00, and it carries the four hourly jobs', () => {
    const atZero = SCHEDULED_JOB_DESCRIPTORS.filter(
      (d) => firesAtMinuteZero(d.cron) && d.cron.split(' ')[1] === '*'
    ).map((d) => d.name);
    expect(atZero).toEqual(['hourly']);
    expect(stepsOf('hourly')).toEqual(
      expect.arrayContaining([
        'exchange-balances',
        'pricing',
        'stale-sync-probe',
        'wallet-balances',
      ])
    );
  });
});

/**
 * Neon suspends 300s after its last query, so every minute a frequent job
 * fires on is a wake of at least five minutes (SC-1611). The hourly syncs wake
 * it at :00 and the quarter-hour jobs at :02/:17/:32/:47; anything hourly or
 * faster fires inside one of those wakes, up to 4 minutes after it, while the
 * database is still up (active-pricing rides the quarter-hour wake at :03).
 */
const WAKE_ANCHORS = [0, 2, 17, 32, 47];
const SHARES_A_WAKE_MINUTES = 4;
const WAKE_MINUTES = new Set(
  WAKE_ANCHORS.flatMap((anchor) =>
    Array.from({ length: SHARES_A_WAKE_MINUTES + 1 }, (_, i) => (anchor + i) % 60)
  )
);

function expandMinutes(field: string): number[] {
  return field.split(',').flatMap((part) => {
    const [range = '*', stepText] = part.split('/');
    const step = stepText ? Number(stepText) : 1;
    const [lo, hi] =
      range === '*'
        ? [0, 59]
        : range.includes('-')
          ? range.split('-').map(Number)
          : [Number(range), stepText ? 59 : Number(range)];
    const out: number[] = [];
    for (let m = lo!; m <= hi!; m += step) out.push(m);
    return out;
  });
}

describe('the wakes', () => {
  test('every hourly-or-faster job fires only on a minute the database is already awake for', () => {
    const offWake = SCHEDULED_JOB_DESCRIPTORS.filter((d) => d.cron.split(' ')[1] === '*')
      .map((d) => ({
        name: d.name,
        off: expandMinutes(minutesOf(d.cron)).filter((m) => !WAKE_MINUTES.has(m)),
      }))
      .filter((d) => d.off.length > 0);
    expect(offWake).toEqual([]);
  });

  test('CONTROL: the minute parser reads each form the registry uses', () => {
    expect(expandMinutes('2-59/15')).toEqual([2, 17, 32, 47]);
    expect(expandMinutes('*/15')).toEqual([0, 15, 30, 45]);
    expect(expandMinutes('5')).toEqual([5]);
    expect(expandMinutes('0,30')).toEqual([0, 30]);
    // A fire 10 minutes past a wake has slept through the 300s window.
    expect(WAKE_MINUTES.has(3)).toBe(true);
    expect(WAKE_MINUTES.has(10)).toBe(false);
    expect(WAKE_MINUTES.has(25)).toBe(false);
  });
});
