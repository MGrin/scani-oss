import { describe, expect, test } from 'bun:test';
import { SCHEDULED_JOB_DESCRIPTORS, SCHEDULED_JOB_STEPS } from '../../src/scheduled-jobs';

const steps = Object.values(SCHEDULED_JOB_STEPS);
const isGroup = (d: (typeof SCHEDULED_JOB_DESCRIPTORS)[number]) => 'steps' in d;
const groupOf = (step: string) =>
  SCHEDULED_JOB_DESCRIPTORS.find((d) => 'steps' in d && d.steps.some((s) => s.name === step));

describe('SCHEDULED_JOB_DESCRIPTORS registry', () => {
  test('every descriptor has a name and a cron pattern', () => {
    for (const d of SCHEDULED_JOB_DESCRIPTORS) {
      expect(d.name).toBeTruthy();
      expect(d.cron).toBeTruthy();
    }
  });

  test('reconcile-* steps deliberately omit lockName (idempotent re-scans)', () => {
    const reconcilers = steps.filter((d) => d.name.startsWith('reconcile-'));
    expect(reconcilers.length).toBeGreaterThan(0);
    for (const d of reconcilers) {
      expect(d.lockName).toBeUndefined();
    }
  });

  test('every other step, and every standalone schedule, locks on its own name', () => {
    const lockers = [
      ...steps.filter((d) => !d.name.startsWith('reconcile-')),
      ...SCHEDULED_JOB_DESCRIPTORS.filter((d) => !isGroup(d)),
    ];
    for (const d of lockers) {
      expect(d.lockName).toBe(d.name);
    }
  });

  // A group overlapping its previous run is safe because each step locks on
  // its own name; a group lock would skip a whole run behind one slow step.
  test('a group takes no lock of its own (SC-1688)', () => {
    for (const d of SCHEDULED_JOB_DESCRIPTORS.filter(isGroup)) {
      expect(d.lockName).toBeUndefined();
    }
  });

  // Foundation A3, Task 10: the historical price backfill prices every
  // currency in use, so nothing is left for a forex job to do.
  test('no descriptor is named forex-backfill', () => {
    expect([...SCHEDULED_JOB_DESCRIPTORS, ...steps].map((d) => d.name)).not.toContain(
      'forex-backfill'
    );
  });

  // Foundation A3, Task 24: a reading keeps the resolution it was stored at,
  // so nothing collapses intraday readings into a daily one. The boot removes
  // a schedule no descriptor names (job-scheduler.test.ts).
  test('no descriptor is named token-prices-downsample', () => {
    expect([...SCHEDULED_JOB_DESCRIPTORS, ...steps].map((d) => d.name)).not.toContain(
      'token-prices-downsample'
    );
  });

  test('descriptor names are unique', () => {
    const names = [...SCHEDULED_JOB_DESCRIPTORS.map((d) => d.name), ...steps.map((d) => d.name)];
    expect(new Set(names).size).toBe(names.length);
  });

  test('cron patterns parse as 5-field expressions', () => {
    for (const d of SCHEDULED_JOB_DESCRIPTORS) {
      expect(d.cron.split(' ')).toHaveLength(5);
    }
  });

  test('every fixed-minute schedule lands on a quarter hour', () => {
    // The quarter-hour alignment is not tidiness: the advisory locks batch
    // into one database wake and Neon scales to zero between them. A job at
    // :07 buys nothing and costs an extra wake.
    for (const d of SCHEDULED_JOB_DESCRIPTORS) {
      const minute = d.cron.split(' ')[0] as string;
      if (minute.startsWith('*')) continue;
      // The quarter-hour probes run 2 minutes past each quarter (SC-1601) so
      // they stop queueing behind the :00 syncs. 2 minutes is inside Neon's
      // 300s suspend timeout, so they still share the wake of whatever fired
      // on the quarter, and the number of wakes is unchanged.
      // `active-pricing` runs a minute after them (SC-1602): still inside that
      // 300s, so it rides the same wake rather than adding a fifth job to the
      // probes' four scheduled slots.
      if (minute === '2-59/15' || minute === '3-59/15') continue;
      expect([0, 15, 30, 45]).toContain(Number(minute));
    }
  });

  test('weekly-digest fires after the nightly rollup, never before it', () => {
    // The digest quotes `portfolio_value_daily`. Firing ahead of the rollup
    // would mail the previous day's figure and call it this week's (SC-460).
    // The rollup is a step of the nightly group (SC-1688), so the digest must
    // fire hours after that group starts.
    const digest = SCHEDULED_JOB_DESCRIPTORS.find((d) => d.name === 'weekly-digest');
    const nightly = groupOf('portfolio-value-rollup');
    expect(digest).toBeDefined();
    expect(nightly?.name).toBe('nightly');
    const [digestMinute, digestHour, , , weekday] = (digest as { cron: string }).cron.split(' ');
    const nightlyHour = (nightly as { cron: string }).cron.split(' ')[1] as string;
    expect(Number(digestHour)).toBeGreaterThan(Number(nightlyHour));
    expect(Number(digestMinute)).toBe(0);
    // A weekday field, not `*` — a "weekly" digest on every day is a daily one.
    expect(weekday).not.toBe('*');
  });

  test('alert-sweep never shares an hour with the weekly digest', () => {
    // Both mail the same inbox and one of them is weekly, so they collide on
    // Mondays. Two letters arriving in the same second read as one system
    // mailing twice, which is the shape that gets a sender filtered (SC-459).
    const sweepGroup = groupOf('alert-sweep');
    const digest = SCHEDULED_JOB_DESCRIPTORS.find((d) => d.name === 'weekly-digest');
    expect(sweepGroup).toBeDefined();
    expect(groupOf('weekly-digest')).toBeUndefined();
    const sweepHour = (sweepGroup as { cron: string }).cron.split(' ')[1];
    const digestHour = (digest as { cron: string }).cron.split(' ')[1];
    expect(sweepHour).not.toBe(digestHour);
  });
});
