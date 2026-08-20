import { describe, expect, test } from 'bun:test';
import { SCHEDULED_JOB_DESCRIPTORS } from '../../src/scheduled-jobs';

describe('SCHEDULED_JOB_DESCRIPTORS registry', () => {
  test('every descriptor has a name and a cron pattern', () => {
    for (const d of SCHEDULED_JOB_DESCRIPTORS) {
      expect(d.name).toBeTruthy();
      expect(d.cron).toBeTruthy();
    }
  });

  test('reconcile-* descriptors deliberately omit lockName (idempotent re-scans)', () => {
    const reconcilers = SCHEDULED_JOB_DESCRIPTORS.filter((d) => d.name.startsWith('reconcile-'));
    expect(reconcilers.length).toBeGreaterThan(0);
    for (const d of reconcilers) {
      expect(d.lockName).toBeUndefined();
    }
  });

  test('every non-reconciler has a lockName matching its job name', () => {
    for (const d of SCHEDULED_JOB_DESCRIPTORS) {
      if (d.name.startsWith('reconcile-')) continue;
      expect(d.lockName).toBe(d.name);
    }
  });

  test('descriptor names are unique', () => {
    const names = SCHEDULED_JOB_DESCRIPTORS.map((d) => d.name);
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
    // :07 buys nothing and costs an extra wake. `payment-due-reminder` is the
    // one exception and states its reason in its own descriptor.
    for (const d of SCHEDULED_JOB_DESCRIPTORS) {
      if (d.name === 'payment-due-reminder') continue;
      const minute = d.cron.split(' ')[0] as string;
      if (minute.startsWith('*')) continue;
      expect([0, 15, 30, 45]).toContain(Number(minute));
    }
  });

  test('weekly-digest fires after the nightly rollup, never before it', () => {
    // The digest quotes `portfolio_value_daily`. Firing ahead of the 04:00
    // rollup would mail the previous day's figure and call it this week's
    // (SC-460).
    const digest = SCHEDULED_JOB_DESCRIPTORS.find((d) => d.name === 'weekly-digest');
    const rollup = SCHEDULED_JOB_DESCRIPTORS.find((d) => d.name === 'portfolio-value-rollup');
    expect(digest).toBeDefined();
    const [digestMinute, digestHour, , , weekday] = (digest as { cron: string }).cron.split(' ');
    const rollupHour = (rollup as { cron: string }).cron.split(' ')[1] as string;
    expect(Number(digestHour)).toBeGreaterThan(Number(rollupHour));
    expect(Number(digestMinute)).toBe(0);
    // A weekday field, not `*` — a "weekly" digest on every day is a daily one.
    expect(weekday).not.toBe('*');
  });

  test('alert-sweep never shares an hour with the weekly digest', () => {
    // Both mail the same inbox and one of them is weekly, so they collide on
    // Mondays. Two letters arriving in the same second read as one system
    // mailing twice, which is the shape that gets a sender filtered (SC-459).
    const sweep = SCHEDULED_JOB_DESCRIPTORS.find((d) => d.name === 'alert-sweep');
    const digest = SCHEDULED_JOB_DESCRIPTORS.find((d) => d.name === 'weekly-digest');
    expect(sweep).toBeDefined();
    const sweepHour = (sweep as { cron: string }).cron.split(' ')[1];
    const digestHour = (digest as { cron: string }).cron.split(' ')[1];
    expect(sweepHour).not.toBe(digestHour);
  });
});
