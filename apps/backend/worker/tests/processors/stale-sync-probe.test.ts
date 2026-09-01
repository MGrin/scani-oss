import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { getDb } from '@scani/db';
import { InstitutionRepository, type StaleSyncTarget } from '@scani/domain/repositories';
import { restoreContainerAfterAll } from '@scani/domain/test-helpers';
import { STALE_SYNC_ALARM } from '@scani/jobs';
import { sql } from 'drizzle-orm';
import { Container } from 'typedi';
import { __test_runStaleSyncProbe } from '../../src/processors/stale-sync-probe';

// Container stubs are process-global; put back whatever this file changes
// so no later test file resolves them (SC-448).
restoreContainerAfterAll();

/**
 * The probe fires on ENTERING a condition, not on every hourly run that
 * observes it (SC-870).
 *
 * These run against the real `OperatorAlarmRepository` and the real table on
 * purpose. An in-memory stand-in for the ledger would be the thing under test
 * pretending to be its own fixture: the whole claim is that state SURVIVES
 * between probes, and a Map in the test file proves that about the Map.
 * Only `findStaleSyncTargets` and `captureException` are stubbed — the input
 * and the output.
 */

const HOUR = 60 * 60 * 1000;

const target = (credentialId: string, institutionName: string): StaleSyncTarget => ({
  credentialId,
  userId: `user-for-${credentialId}`,
  institutionId: `inst-for-${credentialId}`,
  institutionName,
  kind: 'orphaned-credential',
});

/** What the probe currently sees. Reassigned between probes to move the world. */
let current: StaleSyncTarget[] = [];

function harness() {
  const captured: Array<{ message: string; tags?: Record<string, string> }> = [];
  Container.set(InstitutionRepository, {
    findStaleSyncTargets: async () => current,
  } as unknown as InstitutionRepository);
  const captureException = (err: unknown, tags?: Record<string, string>) => {
    captured.push({ message: err instanceof Error ? err.message : String(err), tags });
  };
  const probeAt = (hoursFromStart: number) =>
    __test_runStaleSyncProbe(3, new Date(Date.UTC(2026, 0, 1) + hoursFromStart * HOUR), {
      captureException,
    });
  return { captured, probeAt };
}

async function clearAlarmRows(): Promise<void> {
  await getDb().execute(sql`delete from operator_alarms where alarm = ${STALE_SYNC_ALARM}`);
}

beforeEach(async () => {
  current = [];
  await clearAlarmRows();
});
afterEach(clearAlarmRows);

describe('stale-sync probe', () => {
  test('a condition that persists escalates once, not once per probe', async () => {
    const { captured, probeAt } = harness();
    current = [target('cred-1', 'Binance')];

    await probeAt(0);
    await probeAt(1);
    await probeAt(2);

    expect(captured).toHaveLength(1);
    expect(captured[0]?.message).toContain('Binance');
  });

  test('a condition that clears and returns escalates again', async () => {
    const { captured, probeAt } = harness();

    current = [target('cred-1', 'Binance')];
    await probeAt(0);
    current = [];
    await probeAt(1);
    current = [target('cred-1', 'Binance')];
    await probeAt(2);

    expect(captured).toHaveLength(2);
  });

  test('recovery is recorded but never escalated — a fixed thing is not an error', async () => {
    const { captured, probeAt } = harness();

    current = [target('cred-1', 'Binance')];
    await probeAt(0);
    current = [];
    await probeAt(1);

    // Exactly the entry, and nothing for the exit. A `captureException` on good
    // news opens a Sentry issue nobody can resolve, and the observable proof
    // that the alarm re-armed is the NEXT break firing — asserted above.
    expect(captured).toHaveLength(1);
  });

  test('a second integration breaking escalates, and names only the new one', async () => {
    const { captured, probeAt } = harness();

    current = [target('cred-1', 'Binance')];
    await probeAt(0);
    current = [target('cred-1', 'Binance'), target('cred-2', 'Kraken')];
    await probeAt(1);

    expect(captured).toHaveLength(2);
    // The already-open one must not ride along: repeating it is how the second
    // event becomes a copy of the first and Sentry groups them together.
    expect(captured[1]?.message).toContain('Kraken');
    expect(captured[1]?.message).not.toContain('Binance');
  });

  test('a condition true throughout is re-stated once a week, not once an hour', async () => {
    const { captured, probeAt } = harness();
    current = [target('cred-1', 'Binance')];

    // 24 hourly probes, then one past the re-notify window.
    for (let hour = 0; hour < 24; hour++) await probeAt(hour);
    expect(captured).toHaveLength(1);

    await probeAt(7 * 24 + 1);
    expect(captured).toHaveLength(2);
    expect(captured[1]?.tags?.transition).toBe('restated');
  });

  test('nothing broken escalates nothing', async () => {
    const { captured, probeAt } = harness();
    await probeAt(0);
    expect(captured).toHaveLength(0);
  });
});
