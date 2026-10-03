import { describe, expect, test } from 'bun:test';
import { widenToEarliestWrite } from '../../src/lib/rebuild-window';

/**
 * SC-1459. The rebuild an import queues was sized from the snapshot's age
 * alone, so a row written 200 days back into a portfolio snapshotted
 * yesterday rebuilt 8 days and left the other 192 stale.
 */
describe('widenToEarliestWrite', () => {
  const NOW = new Date('2026-09-30T12:00:00Z');
  const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

  test('a row 200 days back widens an 8-day window past it', () => {
    expect(widenToEarliestWrite(8, daysAgo(200), NOW)).toBeGreaterThanOrEqual(200);
  });

  test('an opening balance 547 days back reaches past the 400-day default', () => {
    expect(widenToEarliestWrite(400, daysAgo(547), NOW)).toBeGreaterThanOrEqual(547);
  });

  test('control: an import of recent rows keeps the snapshot window, so an hourly sync stays small', () => {
    expect(widenToEarliestWrite(8, daysAgo(0), NOW)).toBe(8);
    expect(widenToEarliestWrite(8, null, NOW)).toBe(8);
  });

  test('the window is capped at the schema maximum', () => {
    expect(widenToEarliestWrite(8, daysAgo(365 * 200), NOW)).toBe(365 * 100);
  });
});
