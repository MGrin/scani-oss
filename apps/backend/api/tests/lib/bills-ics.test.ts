import { describe, expect, test } from 'bun:test';
import { buildBillsIcs } from '../../src/lib/bills-ics';

const NOW = new Date('2026-10-10T12:34:56Z');

function lines(ics: string): string[] {
  // Unfold first: a continuation line starts with one space (RFC 5545 §3.1).
  return ics.replace(/\r\n /g, '').split('\r\n');
}

describe('buildBillsIcs (SC-1654)', () => {
  const ics = buildBillsIcs({
    calendarName: 'Scani bills',
    now: NOW,
    events: [
      { uid: 'occ-1', date: '2026-11-01', summary: 'Hyperoptic · £42.00' },
      { uid: 'occ-2', date: '2026-12-31', summary: 'Smith, Jones; Co\\Ltd\nRent' },
    ],
  });

  test('a calendar with one all-day event per bill, every line ending in CRLF', () => {
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(ics.replace(/\r\n/g, '')).not.toContain('\n');
    const all = lines(ics);
    expect(all).toContain('VERSION:2.0');
    expect(all).toContain('X-WR-CALNAME:Scani bills');
    expect(all.filter((line) => line === 'BEGIN:VEVENT')).toHaveLength(2);
    expect(all).toContain('DTSTART;VALUE=DATE:20261101');
    expect(all).toContain('DTEND;VALUE=DATE:20261102');
    expect(all).toContain('UID:occ-1@scani.xyz');
    expect(all).toContain('DTSTAMP:20261010T123456Z');
  });

  test('the end date of the last day of a year rolls into the next year', () => {
    expect(lines(ics)).toContain('DTEND;VALUE=DATE:20270101');
  });

  test('text is escaped: backslash, semicolon, comma and newline', () => {
    expect(lines(ics)).toContain('SUMMARY:Smith\\, Jones\\; Co\\\\Ltd\\nRent');
  });

  test('no physical line is longer than 75 octets, and folding keeps multibyte characters whole', () => {
    const long = buildBillsIcs({
      calendarName: 'Scani bills',
      now: NOW,
      events: [{ uid: 'occ-3', date: '2026-11-01', summary: `${'£€'.repeat(40)} end` }],
    });
    for (const line of long.split('\r\n')) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    }
    expect(lines(long)).toContain(`SUMMARY:${'£€'.repeat(40)} end`);
  });

  test('no bills is still a valid, empty calendar', () => {
    const empty = buildBillsIcs({ calendarName: 'Scani bills', now: NOW, events: [] });
    expect(lines(empty)).not.toContain('BEGIN:VEVENT');
    expect(empty.endsWith('END:VCALENDAR\r\n')).toBe(true);
  });
});
