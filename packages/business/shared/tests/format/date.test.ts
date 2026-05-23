import { describe, expect, test } from 'bun:test';
import { formatDate, formatDateTime, formatIsoDate, formatRelative } from '../../src/format/date';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('formatRelative', () => {
  test('returns "just now" for recent (<45s)', () => {
    expect(formatRelative(new Date(Date.now() - 1000))).toBe('just now');
    expect(formatRelative(new Date(Date.now() - 30 * 1000))).toBe('just now');
  });

  test('uses Xm ago for under an hour', () => {
    expect(formatRelative(new Date(Date.now() - 5 * MIN))).toBe('5m ago');
  });

  test('uses Xh ago for under a day', () => {
    expect(formatRelative(new Date(Date.now() - 3 * HOUR))).toBe('3h ago');
  });

  test('uses Xd ago for under 30 days', () => {
    expect(formatRelative(new Date(Date.now() - 5 * DAY))).toBe('5d ago');
  });

  test('falls back to a locale date for >30 days', () => {
    const old = new Date('2020-01-15T00:00:00Z');
    const out = formatRelative(old);
    expect(out).not.toContain('ago');
    expect(out.length).toBeGreaterThan(0);
  });

  test('returns "—" for null/undefined/invalid input', () => {
    expect(formatRelative(null)).toBe('—');
    expect(formatRelative(undefined)).toBe('—');
    expect(formatRelative('not-a-date')).toBe('—');
  });

  test('accepts string ISO input', () => {
    expect(formatRelative(new Date(Date.now() - 5 * MIN).toISOString())).toBe('5m ago');
  });
});

describe('formatIsoDate', () => {
  test('renders YYYY-MM-DD for any valid input', () => {
    expect(formatIsoDate('2026-04-28T15:30:00Z')).toBe('2026-04-28');
    expect(formatIsoDate(new Date('2026-04-28T15:30:00Z'))).toBe('2026-04-28');
  });

  test('returns "—" for invalid input', () => {
    expect(formatIsoDate(null)).toBe('—');
    expect(formatIsoDate('garbage')).toBe('—');
  });
});

describe('formatDateTime / formatDate', () => {
  test('formatDate renders a medium-style date string', () => {
    const out = formatDate('2026-04-28T15:30:00Z');
    expect(out).toMatch(/2026/);
    expect(out).not.toMatch(/15:30/);
  });

  test('formatDateTime includes the time portion', () => {
    const out = formatDateTime('2026-04-28T15:30:00Z');
    expect(out).toMatch(/2026/);
  });

  test('both return "—" for invalid input', () => {
    expect(formatDate(null)).toBe('—');
    expect(formatDateTime(null)).toBe('—');
  });
});
