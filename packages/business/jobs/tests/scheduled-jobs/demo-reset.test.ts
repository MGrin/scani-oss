import { describe, expect, test } from 'bun:test';
import { DEMO_RESET_SCHEDULE, SCHEDULED_JOB_DESCRIPTORS } from '../../src/scheduled-jobs';

/**
 * SC-466. `demo-reset` is the one schedule deliberately kept OUT of
 * `SCHEDULED_JOB_DESCRIPTORS` — the worker arms it only under
 * `SCANI_DEMO_MODE=1`, and arms nothing else in that case. Every invariant the
 * registry test enforces on the others therefore has to be asserted here by
 * hand, because the loop over the registry cannot see this one.
 */
describe('DEMO_RESET_SCHEDULE', () => {
  test('is NOT in the default registry — a normal deployment must never arm it', () => {
    const names = SCHEDULED_JOB_DESCRIPTORS.map((d) => d.name);
    expect(names).not.toContain(DEMO_RESET_SCHEDULE.name);
  });

  test('holds a lock on its own name — two resets would delete each other’s user', () => {
    expect(DEMO_RESET_SCHEDULE.lockName).toBe(DEMO_RESET_SCHEDULE.name);
  });

  test('is a 5-field cron on a quarter hour, like every other fixed-minute job', () => {
    // Not tidiness: the advisory locks batch into one database wake and Neon
    // scales to zero between them.
    const fields = DEMO_RESET_SCHEDULE.cron.split(' ');
    expect(fields).toHaveLength(5);
    expect([0, 15, 30, 45]).toContain(Number(fields[0]));
  });

  test('fires after every nightly job that rewrites what the seed contains', () => {
    // On a demo instance none of these are armed — the worker registers the
    // reset alone. The hour still has to be defensible on a normal deployment,
    // because that is where this descriptor's comment claims it is safe, and
    // because a demo instance that is ever run WITH the normal registry (a
    // half-applied config, a rollback) must not reset into the chain's teeth.
    const CHAIN = [
      'historical-price-backfill',
      'forex-backfill',
      'transfer-linking',
      'portfolio-value-rollup',
      'hide-closed-holdings',
      'token-prices-downsample',
      'backfill-counterparty',
    ];
    const hours = CHAIN.map((name) => {
      const descriptor = SCHEDULED_JOB_DESCRIPTORS.find((d) => d.name === name);
      expect(descriptor).toBeDefined();
      return Number((descriptor as { cron: string }).cron.split(' ')[1]);
    });
    const resetHour = Number(DEMO_RESET_SCHEDULE.cron.split(' ')[1]);
    expect(resetHour).toBeGreaterThan(Math.max(...hours));
  });
});
