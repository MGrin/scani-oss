import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEMO_RESET_SCHEDULE, SCHEDULED_JOB_DESCRIPTORS } from '@scani/jobs';

/**
 * SC-466. `demo-reset` is invisible to `scheduled-processor-coverage.test.ts`,
 * and deliberately so: that file walks `SCHEDULED_JOB_DESCRIPTORS`, and this
 * descriptor is not in it. Everything that test protects therefore has to be
 * protected here separately, or the one schedule a demo instance runs is the
 * one nothing checks.
 *
 * Both failures are silent in exactly the way SC-283 describes. A processor
 * dropped from `resolveProcessors()` does not fail the build, a test or boot —
 * it fails once a night, in production, into the DLQ. A demo instance that arms
 * the full registry does not fail at all: it quietly overwrites the seeded
 * price series with real quotes and recomputes the rollup over invented
 * transactions, and the demo is simply wrong from then until the next reset.
 */

const SOURCE = readFileSync(join(import.meta.dir, '..', 'src', 'index.ts'), 'utf8');

describe('the demo reset is wired even though the registry cannot see it', () => {
  test('DemoResetProcessor is listed in resolveProcessors()', () => {
    const body = SOURCE.match(/function resolveProcessors\(\)\s*\{\s*return\s*\[([\s\S]*?)\]/)?.[1];
    expect(body).toBeDefined();
    expect(body).toContain('Container.get(DemoResetProcessor)');
  });

  test('its processor file binds the descriptor this test imports', () => {
    const processor = readFileSync(
      join(import.meta.dir, '..', 'src', 'processors', 'demo-reset.ts'),
      'utf8'
    );
    expect(processor).toContain('readonly descriptor = DEMO_RESET_SCHEDULE');
  });

  test('the schedule list is conditional on demo mode, and swaps rather than adds', () => {
    // `upsertAll` reconciles: passing the short list is what REMOVES whatever a
    // previous boot armed. Appending to the full list instead would leave the
    // hourly pricing job running against the seeded series.
    const decision = SOURCE.match(
      /const schedules = isDemoModeRequested\(process\.env\)\s*\?\s*\[([^\]]*)\]\s*:\s*(\w+);/
    );
    expect(decision).not.toBeNull();
    expect(decision?.[1]?.trim()).toBe('DEMO_RESET_SCHEDULE');
    expect(decision?.[2]).toBe('SCHEDULED_JOB_DESCRIPTORS');
    expect(SOURCE).toContain('upsertAll(schedules)');
  });

  test('the two lists are disjoint, so the swap cannot be a no-op', () => {
    expect(SCHEDULED_JOB_DESCRIPTORS.map((d) => d.name)).not.toContain(DEMO_RESET_SCHEDULE.name);
    expect(SCHEDULED_JOB_DESCRIPTORS.length).toBeGreaterThan(10);
  });
});
