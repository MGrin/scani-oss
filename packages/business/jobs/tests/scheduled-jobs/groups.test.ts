import { describe, expect, test } from 'bun:test';
import type { ScheduledJobGroupDescriptor } from '@scani/queue';
import { SCHEDULED_JOB_DESCRIPTORS, SCHEDULED_JOB_STEPS } from '../../src/scheduled-jobs';

/**
 * SC-1688: 26 schedules became 6 here (the worker adds billing's one). Each
 * job that had its own schedule now runs either as a step of a group or, for
 * active-pricing and weekly-digest, as a schedule of its own.
 */

const EVERY_JOB_BEFORE_SC1688 = [
  'activation-nudge',
  'active-pricing',
  'alert-sweep',
  'apy-payouts',
  'backfill-counterparty',
  'backfill-token-identity',
  'db-backup',
  'dlq-depth-probe',
  'engine-shadow',
  'exchange-balances',
  'exchange-transactions',
  'hide-closed-holdings',
  'historical-price-backfill',
  'job-heartbeat-probe',
  'payment-due-reminder',
  'payment-horizon-roll',
  'portfolio-value-rollup',
  'pricing',
  'reconcile-orphaned-user-jobs',
  'reconcile-pending-credentials',
  'rescore-scam-tokens',
  'split-holding-probe',
  'stale-sync-probe',
  'transfer-linking',
  'wallet-balances',
  'weekly-digest',
];

const isGroup = (d: unknown): d is ScheduledJobGroupDescriptor =>
  Array.isArray((d as { steps?: unknown }).steps);

const groups = SCHEDULED_JOB_DESCRIPTORS.filter(isGroup);
const group = (name: string) => groups.find((g) => g.name === name) as ScheduledJobGroupDescriptor;
const stepNames = (name: string) => group(name).steps.map((s) => s.name);
const ranOn = (stepsOf: string, step: string, day: string) =>
  group(stepsOf)
    .steps.find((s) => s.name === step)
    ?.runOn?.(new Date(`${day}T00:00:00Z`)) ?? true;

describe('grouped schedules (SC-1688)', () => {
  test('six schedules, so the worker arms seven with billing’s', () => {
    expect(SCHEDULED_JOB_DESCRIPTORS.map((d) => d.name).sort()).toEqual(
      ['active-pricing', 'housekeeping', 'hourly', 'morning', 'nightly', 'weekly-digest'].sort()
    );
  });

  test('every job that had its own schedule still runs, exactly once', () => {
    const standalone = SCHEDULED_JOB_DESCRIPTORS.filter((d) => !isGroup(d)).map((d) => d.name);
    const steps = groups.flatMap((g) => g.steps.map((s) => s.name));
    expect([...standalone, ...steps].sort()).toEqual([...EVERY_JOB_BEFORE_SC1688].sort());
  });

  test('every step has its descriptor, so each keeps its own lock and heartbeat name', () => {
    for (const g of groups) {
      for (const s of g.steps) expect(SCHEDULED_JOB_STEPS[s.name]?.name).toBe(s.name);
    }
  });

  test('the cadences: quarter-hour, hourly, nightly at 00:00, morning at 09:00', () => {
    expect(group('housekeeping').cron).toBe('2-59/15 * * * *');
    expect(group('hourly').cron).toBe('0 * * * *');
    expect(group('nightly').cron).toBe('0 0 * * *');
    expect(group('morning').cron).toBe('0 9 * * *');
  });

  test('the nightly chain runs its hard dependencies in order', () => {
    const order = stepNames('nightly');
    const before = (a: string, b: string) =>
      expect(order.indexOf(a)).toBeLessThan(order.indexOf(b));
    before('historical-price-backfill', 'portfolio-value-rollup');
    before('transfer-linking', 'portfolio-value-rollup');
    before('exchange-transactions', 'transfer-linking');
    before('portfolio-value-rollup', 'hide-closed-holdings');
    before('portfolio-value-rollup', 'split-holding-probe');
    before('portfolio-value-rollup', 'engine-shadow');
    before('transfer-linking', 'backfill-counterparty');
  });

  test('db-backup is the last nightly step, after everything it backs up', () => {
    expect(stepNames('nightly').at(-1)).toBe('db-backup');
    // Every night, whatever failed before it: the runner never skips a later
    // step (scheduled-job-group.test.ts), and no day filter may either.
    const nightly = SCHEDULED_JOB_DESCRIPTORS.find((d) => d.name === 'nightly');
    const backup = (nightly as { steps: readonly { name: string; runOn?: unknown }[] }).steps.at(
      -1
    );
    expect(backup?.runOn).toBeUndefined();
  });

  test('the hourly stale-sync probe reads the syncs after they ran', () => {
    const order = stepNames('hourly');
    expect(order.indexOf('stale-sync-probe')).toBeGreaterThan(order.indexOf('wallet-balances'));
    expect(order.indexOf('stale-sync-probe')).toBeGreaterThan(order.indexOf('exchange-balances'));
  });

  test('backfill-token-identity still runs on Sundays only', () => {
    expect(ranOn('nightly', 'backfill-token-identity', '2026-10-11')).toBe(true); // Sunday
    expect(ranOn('nightly', 'backfill-token-identity', '2026-10-12')).toBe(false); // Monday
    // CONTROL: a step with no day filter runs every day.
    expect(ranOn('nightly', 'portfolio-value-rollup', '2026-10-12')).toBe(true);
  });

  test('weekly-digest is not grouped with alert-sweep, so they never mail in the same hour', () => {
    const digest = SCHEDULED_JOB_DESCRIPTORS.find((d) => d.name === 'weekly-digest');
    expect(digest?.cron.split(' ')[1]).not.toBe(group('morning').cron.split(' ')[1]);
    expect(stepNames('morning')).toContain('alert-sweep');
  });
});
