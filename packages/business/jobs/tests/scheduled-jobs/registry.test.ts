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
});
