import { describe, expect, test } from 'bun:test';
import { taxYearWindow, taxYearZone } from '../../src/lib/tax-year';

/**
 * `taxYearWindow` — the one place SC-90 turns a year number into two instants.
 *
 * Every arm names the instant it expects in UTC, because the failure this
 * exists to prevent is a boundary one hour off: a disposal in the last hour of
 * a tax year landing in the next one, which reads as a correct figure.
 */
describe('taxYearWindow — the window is [start of year, start of next year)', () => {
  test('jan-1 in UTC is the calendar year', () => {
    const w = taxYearWindow(2024, 'jan-1', 'UTC');
    expect(w.from.toISOString()).toBe('2024-01-01T00:00:00.000Z');
    expect(w.to.toISOString()).toBe('2025-01-01T00:00:00.000Z');
  });

  test('apr-6 in Europe/London starts at local midnight, which is 23:00 UTC in summer time', () => {
    // 6 April is always inside British Summer Time (it starts on the last
    // Sunday of March), so local midnight is 23:00 UTC the day before.
    const w = taxYearWindow(2024, 'apr-6', 'Europe/London');
    expect(w.from.toISOString()).toBe('2024-04-05T23:00:00.000Z');
    expect(w.to.toISOString()).toBe('2025-04-05T23:00:00.000Z');
  });

  test('jan-1 in a zone ahead of UTC starts the previous UTC day', () => {
    // CONTROL for the arm above: a helper that ignored the zone would pass the
    // UTC arm and fail both of these.
    const w = taxYearWindow(2024, 'jan-1', 'Pacific/Auckland');
    expect(w.from.toISOString()).toBe('2023-12-31T11:00:00.000Z');
    expect(w.to.toISOString()).toBe('2024-12-31T11:00:00.000Z');
  });

  test('adjacent years share their boundary, so the years partition time', () => {
    const a = taxYearWindow(2023, 'apr-6', 'Europe/London');
    const b = taxYearWindow(2024, 'apr-6', 'Europe/London');
    expect(a.to.getTime()).toBe(b.from.getTime());
  });

  /**
   * Every start at its boundary in Pacific/Auckland (+12, +13 in daylight
   * time), where the owner often is (Operator ruling, bus #12480). Each start
   * lands on a different offset, and apr-6 2025 is the day NZ daylight time
   * ends, at 03:00, so its midnight is still +13.
   */
  test.each([
    ['jan-1', 2024, '2023-12-31T11:00:00.000Z', '2024-12-31T11:00:00.000Z'],
    ['apr-1', 2024, '2024-03-31T11:00:00.000Z', '2025-03-31T11:00:00.000Z'],
    ['apr-6', 2024, '2024-04-05T11:00:00.000Z', '2025-04-05T11:00:00.000Z'],
    ['jul-1', 2024, '2024-06-30T12:00:00.000Z', '2025-06-30T12:00:00.000Z'],
  ] as const)('%s %d in Pacific/Auckland', (start, year, from, to) => {
    const w = taxYearWindow(year, start, 'Pacific/Auckland');
    expect(w.from.toISOString()).toBe(from);
    expect(w.to.toISOString()).toBe(to);
  });

  test('an unknown zone is refused rather than read as UTC', () => {
    expect(() => taxYearWindow(2024, 'jan-1', 'Mars/Olympus')).toThrow(/time zone/i);
  });
});

describe('taxYearZone — which zone the boundaries were read in, and why', () => {
  test("the user's own zone when one is stored", () => {
    expect(taxYearZone('Pacific/Auckland')).toEqual({
      timeZone: 'Pacific/Auckland',
      source: 'user',
    });
  });

  test('UTC when none is stored, and the fallback is named rather than silent', () => {
    expect(taxYearZone(null)).toEqual({ timeZone: 'UTC', source: 'utc-fallback' });
    expect(taxYearZone('')).toEqual({ timeZone: 'UTC', source: 'utc-fallback' });
  });

  test('a stored zone this runtime does not know also falls back, named', () => {
    expect(taxYearZone('Mars/Olympus')).toEqual({ timeZone: 'UTC', source: 'utc-fallback' });
  });
});
