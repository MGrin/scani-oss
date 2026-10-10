import { describe, expect, test } from 'bun:test';
import { isPriceFetchDue, type PricingCadenceToken } from '../../src/lib/pricing-cadence';

/**
 * SC-1603 (SC-1598 items 4 + 5): the hourly pricing run asks for a stock only
 * while its exchange trades, for FX only once a day, and for both in the
 * 23:00Z hour every day, so the nightly backfill finds every day priced.
 */

const at = (iso: string) => new Date(iso);
const HOUR = 60 * 60 * 1000;
/** Priced an hour before the run: the ordinary case, where only the schedule decides. */
const fresh = (runAt: Date) => new Date(runAt.getTime() - HOUR);

const us: PricingCadenceToken = { typeCode: 'stock', marketSegment: 'US', exchange: null };
const tsx: PricingCadenceToken = { typeCode: 'stock', marketSegment: 'TO', exchange: 'TSX' };
const nasdaqBySymbolInfo: PricingCadenceToken = {
  typeCode: 'stock',
  marketSegment: null,
  exchange: 'NASDAQ',
};
const london: PricingCadenceToken = { typeCode: 'stock', marketSegment: 'L', exchange: 'LSE' };
const fx: PricingCadenceToken = { typeCode: 'fiat', marketSegment: null, exchange: null };
const crypto: PricingCadenceToken = { typeCode: 'crypto', marketSegment: null, exchange: null };

const due = (token: PricingCadenceToken, iso: string) =>
  isPriceFetchDue(token, fresh(at(iso)), at(iso));

describe('crypto', () => {
  test('is asked every hour, weekends included', () => {
    expect(due(crypto, '2026-10-04T03:00:00Z')).toBe(true); // Sunday
    expect(due(crypto, '2026-10-06T12:00:00Z')).toBe(true);
  });
});

describe('FX', () => {
  test('is asked only in the 23:00Z hour', () => {
    expect(due(fx, '2026-10-06T12:00:00Z')).toBe(false);
    expect(due(fx, '2026-10-06T22:00:00Z')).toBe(false);
    expect(due(fx, '2026-10-06T23:00:00Z')).toBe(true);
    expect(due(fx, '2026-10-04T23:00:00Z')).toBe(true); // Sunday too
  });
});

describe('a US stock', () => {
  test('is asked hourly from 10:00 to 16:00 New York time on a weekday', () => {
    expect(due(us, '2026-10-06T13:00:00Z')).toBe(false); // 09:00 EDT, before the open
    expect(due(us, '2026-10-06T14:00:00Z')).toBe(true); // 10:00 EDT
    expect(due(us, '2026-10-06T20:00:00Z')).toBe(true); // 16:00 EDT, the close
    expect(due(us, '2026-10-06T21:00:00Z')).toBe(false); // 17:00 EDT
  });

  test('follows New York across the DST change', () => {
    expect(due(us, '2026-12-01T14:00:00Z')).toBe(false); // 09:00 EST
    expect(due(us, '2026-12-01T15:00:00Z')).toBe(true); // 10:00 EST
    expect(due(us, '2026-12-01T21:00:00Z')).toBe(true); // 16:00 EST
  });

  test('is asked on a weekend only in the 23:00Z hour', () => {
    expect(due(us, '2026-10-03T15:00:00Z')).toBe(false); // Saturday 11:00 EDT
    expect(due(us, '2026-10-03T23:00:00Z')).toBe(true);
  });

  test('is recognised by its listing exchange when it carries no segment', () => {
    expect(due(nasdaqBySymbolInfo, '2026-10-03T15:00:00Z')).toBe(false);
    expect(due(nasdaqBySymbolInfo, '2026-10-06T15:00:00Z')).toBe(true);
  });
});

describe('a TSX stock', () => {
  test('trades on Toronto time', () => {
    expect(due(tsx, '2026-10-06T13:00:00Z')).toBe(false);
    expect(due(tsx, '2026-10-06T14:00:00Z')).toBe(true);
    expect(due(tsx, '2026-10-04T15:00:00Z')).toBe(false); // Sunday
  });
});

describe('never deferred', () => {
  test('a stock on an exchange whose hours are unknown', () => {
    expect(due(london, '2026-10-04T03:00:00Z')).toBe(true);
  });

  test('a token that has never been priced', () => {
    expect(isPriceFetchDue(fx, null, at('2026-10-06T12:00:00Z'))).toBe(true);
    expect(isPriceFetchDue(us, null, at('2026-10-03T15:00:00Z'))).toBe(true);
  });

  test('a token whose newest price is over a day old — a missed 23:00Z run catches up', () => {
    const runAt = at('2026-10-06T12:00:00Z');
    expect(isPriceFetchDue(fx, new Date(runAt.getTime() - 25 * HOUR), runAt)).toBe(true);
    expect(isPriceFetchDue(fx, new Date(runAt.getTime() - 23 * HOUR), runAt)).toBe(false);
  });
});
