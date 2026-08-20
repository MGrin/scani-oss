import { describe, expect, test } from 'bun:test';
import { browserTimezone, shouldReportTimezone } from '../../src/lib/timezone';

/**
 * The gate on SC-226's silent-no-op risk: if nothing writes `users.timezone`,
 * the reminder job selects zero users forever and the failure reads exactly
 * like "nobody had payments due tomorrow".
 */

describe('shouldReportTimezone', () => {
  test('reports when the server has nothing stored yet', () => {
    // The state EVERY user is in until this ships.
    expect(shouldReportTimezone('Asia/Makassar', null)).toBe(true);
    expect(shouldReportTimezone('Asia/Makassar', undefined)).toBe(true);
  });

  test('reports when the zone changed — someone travelled', () => {
    expect(shouldReportTimezone('Europe/London', 'Asia/Makassar')).toBe(true);
  });

  test('stays quiet when it already matches', () => {
    // Otherwise every app launch is a database write, forever.
    expect(shouldReportTimezone('Asia/Makassar', 'Asia/Makassar')).toBe(false);
  });

  test('never reports a zone the browser could not name', () => {
    // Posting null would be rejected by the DTO; not posting keeps the column
    // honestly empty, which the job treats as "unknown" rather than "UTC".
    expect(shouldReportTimezone(null, null)).toBe(false);
    expect(shouldReportTimezone(null, 'Asia/Makassar')).toBe(false);
  });
});

describe('browserTimezone', () => {
  test('returns an IANA zone name this runtime can resolve', () => {
    const zone = browserTimezone();

    expect(zone).not.toBeNull();
    // Whatever it is, it must survive the round trip the server's DTO makes it
    // take — a value Intl cannot interpret is rejected there.
    expect(() => new Intl.DateTimeFormat('en-US', { timeZone: zone as string })).not.toThrow();
  });
});
