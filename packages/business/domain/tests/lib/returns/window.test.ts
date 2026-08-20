import { describe, expect, test } from 'bun:test';
import { resolveReturnWindow } from '../../../src/lib/returns/window';

const NOW = new Date('2026-08-19T11:22:33.444Z');

describe('resolveReturnWindow', () => {
  test('ytd starts on 1 January of the current UTC year', () => {
    const window = resolveReturnWindow({ kind: 'ytd' }, NOW);
    expect(window.from.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(window.to.toISOString()).toBe('2026-08-19T23:59:59.999Z');
  });

  test('1y reaches back 365 days', () => {
    const window = resolveReturnWindow({ kind: '1y' }, NOW);
    expect(window.from.toISOString()).toBe('2025-08-19T00:00:00.000Z');
  });

  test('all reaches back to the epoch, for the series to narrow', () => {
    expect(resolveReturnWindow({ kind: 'all' }, NOW).from.getTime()).toBe(0);
  });

  test('a custom window snaps to whole UTC days at both ends', () => {
    const window = resolveReturnWindow(
      {
        kind: 'custom',
        from: new Date('2026-03-05T18:00:00.000Z'),
        to: new Date('2026-04-06T02:00:00.000Z'),
      },
      NOW
    );
    expect(window.from.toISOString()).toBe('2026-03-05T00:00:00.000Z');
    // End of day, not midnight — otherwise the last day names itself out.
    expect(window.to.toISOString()).toBe('2026-04-06T23:59:59.999Z');
  });
});
