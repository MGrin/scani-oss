import { describe, expect, test } from 'bun:test';
import Decimal from 'decimal.js';
import {
  DRIFT_GROWTH_KIND,
  DRIFT_IN_KIND,
  DRIFT_OUT_KIND,
  driftRows,
} from '../../../src/lib/balances/drift-rows';

const obs = (observedAt: string, balance: string, gapReview: string | null = null) => ({
  observedAt: new Date(observedAt),
  balance,
  gapReview,
});
const ledger = (occurredAt: string, quantity: string) => ({
  occurredAt: new Date(occurredAt),
  quantity,
});
const sum = (rows: { quantity: string }[]) =>
  rows.reduce((s, r) => s.add(r.quantity), new Decimal(0)).toString();

describe('an unexplained balance change becomes rows that follow its interpolation (SC-1470)', () => {
  test('an unanswered drop is money out, spread to each day end exactly as the value ramps', () => {
    const rows = driftRows(
      { holdingId: 'h', tokenId: 'USD' },
      [obs('2026-05-01T12:00:00Z', '1000'), obs('2026-05-03T12:00:00Z', '400')],
      [ledger('2026-04-01T00:00:00Z', '1000')]
    );
    expect(rows.map((r) => r.kind)).toEqual([DRIFT_OUT_KIND, DRIFT_OUT_KIND, DRIFT_OUT_KIND]);
    // 48 hours: ~12h to the first day end (23:59:59.999), 24h, then the rest.
    expect(rows[1]?.quantity).toBe('-300');
    expect(new Decimal(rows[0]?.quantity ?? '0').add(150).abs().lt('0.001')).toBe(true);
    expect(sum(rows)).toBe('-600');
    expect(rows.map((r) => r.occurredAt.toISOString())).toEqual([
      '2026-05-01T23:59:59.999Z',
      '2026-05-02T23:59:59.999Z',
      '2026-05-03T12:00:00.000Z',
    ]);
  });

  test('only what the ledger does not explain, and the parts add up to it exactly', () => {
    const rows = driftRows(
      { holdingId: 'h', tokenId: 'USD' },
      [obs('2026-05-01T00:00:00Z', '100'), obs('2026-05-04T00:00:00Z', '200')],
      [ledger('2026-05-02T10:00:00Z', '70'), ledger('2026-05-01T00:00:00Z', '100')]
    );
    // 200 − 100 − 70; the 100 sits on the first reading, so it explains the opening instead.
    expect(sum(rows)).toBe('30');
    expect(rows.every((r) => r.kind === DRIFT_IN_KIND)).toBe(true);
  });

  test('"unknown" is still money in or out', () => {
    const rows = driftRows(
      { holdingId: 'h', tokenId: 'USD' },
      [obs('2026-05-01T12:00:00Z', '0'), obs('2026-05-01T18:00:00Z', '50', 'unknown')],
      []
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe(DRIFT_IN_KIND);
  });

  test('an owner\'s "growth" answer stays gain', () => {
    const rows = driftRows(
      { holdingId: 'h', tokenId: 'USD' },
      [obs('2026-05-01T12:00:00Z', '100'), obs('2026-05-01T18:00:00Z', '104', 'growth')],
      [ledger('2026-04-01T00:00:00Z', '100')]
    );
    expect(rows.map((r) => [r.kind, r.quantity])).toEqual([[DRIFT_GROWTH_KIND, '4']]);
  });

  test('a holding with no ledger opens as money in just before its first reading, ahead of any gap', () => {
    const rows = driftRows(
      { holdingId: 'h', tokenId: 'USD' },
      [obs('2026-05-01T09:00:00Z', '41648.49'), obs('2026-05-01T21:00:00Z', '22379.37')],
      []
    );
    expect(rows.map((r) => [r.kind, r.quantity, r.occurredAt.toISOString()])).toEqual([
      [DRIFT_IN_KIND, '41648.49', '2026-05-01T08:59:59.999Z'],
      [DRIFT_OUT_KIND, '-19269.12', '2026-05-01T21:00:00.000Z'],
    ]);
    expect(new Set(rows.map((r) => r.id)).size).toBe(2);
  });

  test('a ledger that starts later than the money still opens with what it leaves unexplained', () => {
    // Edge Capital after the owner's withdrawal answer: the ledger's one row
    // is after the first reading, so the 41,749.85 it opened with is still
    // nobody's transaction.
    const rows = driftRows(
      { holdingId: 'h', tokenId: 'USD' },
      [obs('2026-05-17T15:07:54Z', '41749.85'), obs('2026-07-27T23:47:01Z', '22174.58')],
      [ledger('2026-07-27T23:47:01Z', '-19575.27')]
    );
    expect(rows.map((r) => [r.kind, r.quantity])).toEqual([[DRIFT_IN_KIND, '41749.85']]);
  });

  test("the opening is never booked before the first record's own day", () => {
    const rows = driftRows(
      { holdingId: 'h', tokenId: 'USD' },
      [obs('2026-05-01T00:00:00Z', '5')],
      []
    );
    expect(rows[0]?.occurredAt.toISOString()).toBe('2026-05-01T00:00:00.000Z');
  });

  test('control: a ledger that explains the first reading opens with nothing', () => {
    const rows = driftRows(
      { holdingId: 'h', tokenId: 'USD' },
      [obs('2026-05-03T00:00:00Z', '50')],
      [ledger('2026-05-01T00:00:00Z', '30'), ledger('2026-05-02T00:00:00Z', '20')]
    );
    expect(rows).toHaveLength(0);
  });

  test('control: a gap and an opening the ledger explains make no rows', () => {
    expect(
      driftRows(
        { holdingId: 'h', tokenId: 'USD' },
        [obs('2026-05-01T00:00:00Z', '100'), obs('2026-05-02T00:00:00Z', '150')],
        [ledger('2026-04-01T00:00:00Z', '100'), ledger('2026-05-01T12:00:00Z', '50')]
      )
    ).toHaveLength(0);
  });
});
