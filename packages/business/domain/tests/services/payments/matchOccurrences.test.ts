import { describe, expect, test } from 'bun:test';
import {
  type MatchCandidate,
  matchOccurrence,
  type OccurrenceToMatch,
} from '../../../src/services/payments/matchOccurrences';

const DUE_DATE = new Date('2026-03-05T00:00:00.000Z');
const VENDOR_ID = 'vendor-1';
const ACCOUNT_ID = 'account-1';

function occurrence(overrides: Partial<OccurrenceToMatch> = {}): OccurrenceToMatch {
  return {
    dueDate: DUE_DATE,
    expectedAmount: '50.00',
    direction: 'outflow',
    vendorId: VENDOR_ID,
    accountId: null,
    status: 'scheduled',
    matchedTransactionId: null,
    ...overrides,
  };
}

function candidate(overrides: Partial<MatchCandidate> = {}): MatchCandidate {
  return {
    transactionId: 'tx-1',
    amount: '-50.00',
    occurredAt: DUE_DATE,
    accountId: null,
    vendorId: null,
    ...overrides,
  };
}

function daysFrom(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

describe('matchOccurrence', () => {
  test('exact amount + exact date matches', () => {
    const result = matchOccurrence(occurrence(), [candidate()]);
    expect(result?.transactionId).toBe('tx-1');
    expect(result?.score).toBeGreaterThanOrEqual(0.9);
  });

  test('amount within tolerance and date within window matches', () => {
    const result = matchOccurrence(occurrence(), [
      candidate({ amount: '-50.40', occurredAt: daysFrom(DUE_DATE, 1) }),
    ]);
    expect(result).not.toBeNull();
    expect(result?.transactionId).toBe('tx-1');
    expect(result?.score).toBeGreaterThanOrEqual(0.9);
    expect(result?.score).toBeLessThan(1);
  });

  test('two equally-good candidates resolve to null instead of guessing', () => {
    const result = matchOccurrence(occurrence(), [
      candidate({ transactionId: 'tx-early', occurredAt: daysFrom(DUE_DATE, -1) }),
      candidate({ transactionId: 'tx-late', occurredAt: daysFrom(DUE_DATE, 1) }),
    ]);
    expect(result).toBeNull();
  });

  test('a transaction outside the date window does not match', () => {
    const result = matchOccurrence(occurrence(), [
      candidate({ occurredAt: daysFrom(DUE_DATE, 10) }),
    ]);
    expect(result).toBeNull();
  });

  test('re-running over an already-matched occurrence is idempotent', () => {
    const matched = occurrence({ status: 'matched', matchedTransactionId: 'tx-original' });
    const first = matchOccurrence(matched, [
      candidate({ transactionId: 'tx-original' }),
      candidate({ transactionId: 'tx-newer-and-closer', amount: '-50.00', occurredAt: DUE_DATE }),
    ]);
    const second = matchOccurrence(matched, [
      candidate({ transactionId: 'tx-original' }),
      candidate({ transactionId: 'tx-newer-and-closer', amount: '-50.00', occurredAt: DUE_DATE }),
    ]);
    expect(first).toEqual({ transactionId: 'tx-original', score: 1 });
    expect(second).toEqual(first);
  });

  test('direction mismatch never matches, even with exact amount and date', () => {
    // An inflow (positive) candidate for an outflow occurrence.
    const result = matchOccurrence(occurrence({ direction: 'outflow' }), [
      candidate({ amount: '50.00' }),
    ]);
    expect(result).toBeNull();
  });

  test('an unresolved vendor never blocks a match on its own', () => {
    const result = matchOccurrence(occurrence(), [candidate({ vendorId: null })]);
    expect(result).not.toBeNull();
  });

  test('vendor-alias hit disambiguates two otherwise date/amount-tied candidates', () => {
    const result = matchOccurrence(occurrence({ vendorId: VENDOR_ID }), [
      candidate({ transactionId: 'tx-no-vendor', vendorId: null }),
      candidate({ transactionId: 'tx-right-vendor', vendorId: VENDOR_ID }),
    ]);
    expect(result?.transactionId).toBe('tx-right-vendor');
  });

  test('a known account mismatch actively lowers the score rather than staying neutral', () => {
    const withMismatch = matchOccurrence(occurrence({ accountId: ACCOUNT_ID }), [
      candidate({ accountId: 'other-account' }),
    ]);
    const withoutAccountInfo = matchOccurrence(occurrence({ accountId: null }), [
      candidate({ accountId: null }),
    ]);
    expect(withoutAccountInfo).not.toBeNull();
    const mismatchScore = withMismatch?.score ?? 0;
    expect(mismatchScore).toBeLessThan(withoutAccountInfo?.score ?? 1);
  });

  test('a scheduled occurrence with no viable candidates returns null', () => {
    expect(matchOccurrence(occurrence(), [])).toBeNull();
  });

  test('a skipped occurrence never auto-matches, even against an exact candidate', () => {
    const result = matchOccurrence(occurrence({ status: 'skipped' }), [candidate()]);
    expect(result).toBeNull();
  });

  test('an already-matched occurrence with no matchedTransactionId returns null rather than guessing', () => {
    const result = matchOccurrence(occurrence({ status: 'matched', matchedTransactionId: null }), [
      candidate(),
    ]);
    expect(result).toBeNull();
  });
});
