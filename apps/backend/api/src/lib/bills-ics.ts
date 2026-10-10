/**
 * Upcoming bills as an iCalendar feed (SC-1654, RFC 5545). All-day events,
 * CRLF line endings, text escaped and lines folded at 75 octets.
 */
export interface BillsIcsEvent {
  /** Stable across fetches, so a calendar app updates an event rather than duplicating it. */
  uid: string;
  /** `YYYY-MM-DD`. */
  date: string;
  summary: string;
}

const MAX_OCTETS = 75;
const encoder = new TextEncoder();

function escapeText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** Splits at character boundaries, so a multibyte character is never cut in half. */
function fold(line: string): string {
  const parts: string[] = [];
  let current = '';
  let octets = 0;
  for (const char of line) {
    const size = encoder.encode(char).length;
    // A continuation line carries a leading space, which counts towards its 75.
    const limit = parts.length === 0 ? MAX_OCTETS : MAX_OCTETS - 1;
    if (octets + size > limit) {
      parts.push(current);
      current = '';
      octets = 0;
    }
    current += char;
    octets += size;
  }
  parts.push(current);
  return parts.join('\r\n ');
}

function compactDate(date: string): string {
  return date.replace(/-/g, '');
}

function nextDay(date: string): string {
  const next = new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000);
  return compactDate(next.toISOString().slice(0, 10));
}

function stamp(now: Date): string {
  return `${now.toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`;
}

export function buildBillsIcs({
  calendarName,
  now,
  events,
}: {
  calendarName: string;
  now: Date;
  events: readonly BillsIcsEvent[];
}): string {
  const dtstamp = stamp(now);
  const out = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Scani//Bills//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(calendarName)}`,
  ];
  for (const event of events) {
    out.push(
      'BEGIN:VEVENT',
      `UID:${escapeText(event.uid)}@scani.xyz`,
      `DTSTAMP:${dtstamp}`,
      `DTSTART;VALUE=DATE:${compactDate(event.date)}`,
      `DTEND;VALUE=DATE:${nextDay(event.date)}`,
      `SUMMARY:${escapeText(event.summary)}`,
      'TRANSP:TRANSPARENT',
      'END:VEVENT'
    );
  }
  out.push('END:VCALENDAR');
  return `${out.map(fold).join('\r\n')}\r\n`;
}
