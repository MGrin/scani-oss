import { expect, test } from 'bun:test';
import { OverviewObservation } from '../../src/lib/overview-observation';

test('only the fixed schema reaches telemetry; finalization ignores late sibling writes', () => {
  const record = new OverviewObservation();
  record.observe({ phase: 'portfolio', durationMs: 12 });
  record.observe({ cache: 'request_reuse' });
  record.observe({ phase: 'secrets', durationMs: 3 } as never);
  record.observe({ phase: 'details', durationMs: Number.NaN });
  record.observe({ phase: 'presence', durationMs: -1 });
  record.observe({ cache: 'sentinel-key', userId: 'sentinel-id' } as never);
  const snapshot = record.finish(false);
  expect(snapshot).toEqual({
    'overview.schema': 1,
    'overview.completeness': 'partial',
    'overview.cache': 'request_reuse',
    'overview.portfolio_ms': 12,
  });
  record.observe({ phase: 'details', durationMs: 42 });
  expect(record.finish(true)).toBe(snapshot);
  expect(Object.isFrozen(snapshot)).toBe(true);
});

test('complete means all four finite inclusive phases and an actual cache outcome', () => {
  const record = new OverviewObservation();
  for (const phase of ['portfolio', 'details', 'presence', 'compose'] as const) {
    record.observe({ phase, durationMs: 0 });
  }
  record.observe({ cache: 'live', liveReason: 'hidden_inclusive', payload: 'sentinel' } as never);
  expect(record.finish(true)).toEqual({
    'overview.schema': 1,
    'overview.completeness': 'complete',
    'overview.cache': 'live',
    'overview.live_reason': 'hidden_inclusive',
    'overview.portfolio_ms': 0,
    'overview.details_read_ms': 0,
    'overview.presence_read_ms': 0,
    'overview.compose_ms': 0,
  });
});

test('missing cache evidence remains unknown and partial', () => {
  expect(new OverviewObservation().finish(true)).toEqual({
    'overview.schema': 1,
    'overview.completeness': 'partial',
    'overview.cache': 'unknown',
  });
});
