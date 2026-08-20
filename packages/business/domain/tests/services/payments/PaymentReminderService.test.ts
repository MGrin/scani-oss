import { describe, expect, test } from 'bun:test';
import {
  type DueOccurrence,
  localDate,
  localHour,
  localTomorrow,
  reminderBody,
  shouldRemindNow,
  summariseForTomorrow,
} from '../../../src/services/payments/PaymentReminderService';

/**
 * SC-226. The reminder is specified in one sentence and every clause of it is
 * a decision:
 *
 *   "if I have 5 payments tomorrow that totals to 500$ I need to receive a
 *    notification on my phone (PWA) today at around 5PM my local time"
 *
 * These tests pin the three clauses this module owns — one notification,
 * tomorrow, 17:00 LOCAL — with the timezone cases chosen to be the ones a
 * UTC-only implementation gets wrong.
 */

// Bali is +08 with no DST; London is +01 in August and +00 in January. Using
// both is the point: an implementation that stores an offset instead of a
// zone passes in August and fails in January.
const BALI = 'Asia/Makassar';
const LONDON = 'Europe/London';

function occ(over: Partial<DueOccurrence> = {}): DueOccurrence {
  return {
    occurrenceId: 'o1',
    dueDate: '2026-08-16',
    expectedAmount: '100.00',
    currencyTokenId: 't-usd',
    currencySymbol: '$',
    ...over,
  };
}

describe('local time, not UTC', () => {
  test('17:00 in Bali is 09:00 UTC — the user is reminded then, not at 17:00 UTC', () => {
    const at0900Utc = new Date('2026-08-15T09:00:00Z');
    expect(localHour(at0900Utc, BALI)).toBe(17);
    expect(shouldRemindNow(at0900Utc, { userId: 'u', timezone: BALI })).toBe(true);

    // The hour a UTC-only implementation would have chosen. In Bali that is
    // one in the morning, which is the bug this whole selection exists to
    // avoid.
    const at1700Utc = new Date('2026-08-15T17:00:00Z');
    expect(localHour(at1700Utc, BALI)).toBe(1);
    expect(shouldRemindNow(at1700Utc, { userId: 'u', timezone: BALI })).toBe(false);
  });

  test('the same clock time is a different UTC hour in summer and winter', () => {
    // London is UTC+1 in August...
    expect(localHour(new Date('2026-08-15T16:00:00Z'), LONDON)).toBe(17);
    // ...and UTC+0 in January. An offset stored once would be wrong here.
    expect(localHour(new Date('2026-01-15T17:00:00Z'), LONDON)).toBe(17);
    expect(localHour(new Date('2026-01-15T16:00:00Z'), LONDON)).toBe(16);
  });

  test('a null timezone is skipped, never defaulted to UTC', () => {
    // The whole reason the column is nullable. Defaulting would deliver at
    // 01:00 in Bali, and the user could not tell a wrong-hour reminder from a
    // working one.
    const at1700Utc = new Date('2026-08-15T17:00:00Z');
    expect(shouldRemindNow(at1700Utc, { userId: 'u', timezone: null })).toBe(false);
  });

  test('an uninterpretable timezone is skipped rather than throwing the job', () => {
    const at1700Utc = new Date('2026-08-15T17:00:00Z');
    expect(shouldRemindNow(at1700Utc, { userId: 'u', timezone: 'Mars/Olympus' })).toBe(false);
  });
});

describe('tomorrow means the local calendar day, not now + 24h', () => {
  test('late evening in Bali is already the next UTC day', () => {
    // 23:30 in Bali on the 15th is 15:30 UTC on the 15th — same UTC day.
    const evening = new Date('2026-08-15T15:30:00Z');
    expect(localDate(evening, BALI)).toBe('2026-08-15');
    expect(localTomorrow(evening, BALI)).toBe('2026-08-16');
  });

  test('early morning UTC is still yesterday in the Americas', () => {
    const NY = 'America/New_York';
    // 02:00 UTC on the 16th is 22:00 on the 15th in New York.
    const t = new Date('2026-08-16T02:00:00Z');
    expect(localDate(t, NY)).toBe('2026-08-15');
    expect(localTomorrow(t, NY)).toBe('2026-08-16');
  });

  test('crosses a month boundary without drifting', () => {
    expect(localTomorrow(new Date('2026-08-31T09:00:00Z'), BALI)).toBe('2026-09-01');
  });

  test('crosses a leap day', () => {
    expect(localTomorrow(new Date('2028-02-28T09:00:00Z'), BALI)).toBe('2028-02-29');
  });
});

describe('one notification, aggregated', () => {
  const now = new Date('2026-08-15T09:00:00Z'); // 17:00 in Bali

  test("mgrin's own example: 5 payments totalling 500", () => {
    const five = Array.from({ length: 5 }, (_, i) =>
      occ({ occurrenceId: `o${i}`, expectedAmount: '100.00' })
    );
    const s = summariseForTomorrow(now, BALI, five);
    expect(s.count).toBe(5);
    expect(s.totals.get('$')?.toFixed(2)).toBe('500.00');
    expect(reminderBody(s)).toBe('5 payments due tomorrow · $500.00');
  });

  test('payments due today or later than tomorrow are not in it', () => {
    const s = summariseForTomorrow(now, BALI, [
      occ({ occurrenceId: 'today', dueDate: '2026-08-15' }),
      occ({ occurrenceId: 'tomorrow', dueDate: '2026-08-16' }),
      occ({ occurrenceId: 'later', dueDate: '2026-08-17' }),
    ]);
    expect(s.count).toBe(1);
    expect(s.totals.get('$')?.toFixed(2)).toBe('100.00');
  });

  test('mixed currencies are totalled apart, never added together', () => {
    // Summing 100 USD and 100 EUR into "200" would be a number that is not
    // true in any currency. Converting is not this job's business either —
    // it would need a rate, and a rate needs a fetch.
    const s = summariseForTomorrow(now, BALI, [
      occ({ occurrenceId: 'a', currencySymbol: '$', expectedAmount: '100.00' }),
      occ({ occurrenceId: 'b', currencySymbol: '€', expectedAmount: '50.00' }),
    ]);
    expect(s.count).toBe(2);
    expect(s.totals.get('$')?.toFixed(2)).toBe('100.00');
    expect(s.totals.get('€')?.toFixed(2)).toBe('50.00');
    expect(reminderBody(s)).toBe('2 payments due tomorrow · $100.00 + €50.00');
  });

  test('an amount nobody entered is counted, not invented as zero', () => {
    const s = summariseForTomorrow(now, BALI, [
      occ({ occurrenceId: 'known', expectedAmount: '100.00' }),
      occ({ occurrenceId: 'variable', expectedAmount: null }),
    ]);
    expect(s.count).toBe(2);
    expect(s.unknownAmountCount).toBe(1);
    expect(s.totals.get('$')?.toFixed(2)).toBe('100.00');
    // The caveat exists because "2 payments · $100.00" would read as if the
    // total covered both.
    expect(reminderBody(s)).toBe('2 payments due tomorrow · $100.00 (1 with no amount set)');
  });

  test('all-variable payments say the count and no total', () => {
    const s = summariseForTomorrow(now, BALI, [occ({ expectedAmount: null })]);
    expect(reminderBody(s)).toBe('1 payment due tomorrow');
  });

  test('singular reads as one payment', () => {
    const s = summariseForTomorrow(now, BALI, [occ({ expectedAmount: '9.99' })]);
    expect(reminderBody(s)).toBe('1 payment due tomorrow · $9.99');
  });

  test('nothing due tomorrow produces an empty summary the caller can skip', () => {
    const s = summariseForTomorrow(now, BALI, [occ({ dueDate: '2026-09-01' })]);
    expect(s.count).toBe(0);
    expect(s.totals.size).toBe(0);
  });

  test('decimal arithmetic does not drift', () => {
    // 0.1 + 0.2 in float is 0.30000000000000004; the total is money.
    const s = summariseForTomorrow(now, BALI, [
      occ({ occurrenceId: 'a', expectedAmount: '0.10' }),
      occ({ occurrenceId: 'b', expectedAmount: '0.20' }),
    ]);
    expect(s.totals.get('$')?.toFixed(2)).toBe('0.30');
  });
});
