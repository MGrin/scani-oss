import { describe, expect, test } from 'bun:test';
import Decimal from 'decimal.js';
import {
  BED_AND_BREAKFAST_DAYS,
  drawOldestFirst,
  drawPooled,
  type PoolLot,
  planSection104Matches,
  taxDayKey,
  taxDaysBetween,
} from '../../src/lib/lot-matching';

/**
 * The two things the Section 104 walk asserts about itself in comments, tested
 * where they can be seen directly (SC-462): a pooled draw is exact, and the
 * calendar it counts days on is London's.
 */

const lot = (qty: string, cost: string, date: string, holdingId = 'h'): PoolLot => ({
  qty: new Decimal(qty),
  cost: new Decimal(cost),
  date: new Date(date),
  holdingId,
});

describe('drawPooled', () => {
  test('takes exactly what it was asked for, even when the share does not terminate', () => {
    const lots = [
      lot('1', '10', '2023-01-01'),
      lot('1', '20', '2023-02-01'),
      lot('1', '30', '2023-03-01'),
    ];
    const drawn = drawPooled(lots, 'h', new Decimal('1'));

    const qty = drawn.reduce((s, l) => s.add(l.qty), new Decimal(0));
    const cost = drawn.reduce((s, l) => s.add(l.cost), new Decimal(0));
    // A third of each lot is 0.333… — three of them are not 1 unless the last
    // slice absorbs the residual, and a walk that draws 0.999… reports the
    // difference as an acquisition-less disposal priced as pure gain.
    expect(qty.toString()).toBe('1');
    expect(cost.toString()).toBe('20');
    expect(lots.reduce((s, l) => s.add(l.qty), new Decimal(0)).toString()).toBe('2');
    expect(lots.reduce((s, l) => s.add(l.cost), new Decimal(0)).toString()).toBe('40');
  });

  test('leaves the pool average unchanged, which is what makes it a pool', () => {
    const lots = [lot('100', '1000', '2023-01-01'), lot('50', '125000', '2023-09-18')];
    drawPooled(lots, 'h', new Decimal('50'));
    const qty = lots.reduce((s, l) => s.add(l.qty), new Decimal(0));
    const cost = lots.reduce((s, l) => s.add(l.cost), new Decimal(0));
    expect(qty.toString()).toBe('100');
    expect(cost.toString()).toBe('84000');
    expect(cost.div(qty).toString()).toBe('840');
  });

  test('a draw of the whole pool costs exactly what the whole pool cost', () => {
    const lots = [lot('3', '7', '2023-01-01'), lot('11', '13', '2023-02-01')];
    const drawn = drawPooled(lots, 'h', new Decimal('14'));
    expect(drawn.reduce((s, l) => s.add(l.cost), new Decimal(0)).toString()).toBe('20');
    expect(lots.length).toBe(0);
  });

  test('draws nothing for a zero request rather than emitting empty slices', () => {
    const lots = [lot('3', '7', '2023-01-01')];
    expect(drawPooled(lots, 'h', new Decimal(0))).toEqual([]);
    expect(lots.length).toBe(1);
  });

  test('only touches the holding it was asked about', () => {
    const lots = [lot('10', '100', '2023-01-01', 'a'), lot('10', '500', '2023-01-01', 'b')];
    const drawn = drawPooled(lots, 'a', new Decimal('5'));
    expect(drawn.reduce((s, l) => s.add(l.cost), new Decimal(0)).toString()).toBe('50');
    expect((lots.find((l) => l.holdingId === 'b') as PoolLot).cost.toString()).toBe('500');
  });
});

describe('drawOldestFirst', () => {
  test('is FIFO by acquisition date and not by array position', () => {
    // An inherited lot re-enters the pool carrying an older date than the lots
    // already there (SC-344), so position and age disagree.
    const lots = [lot('1', '900', '2023-06-01'), lot('1', '100', '2023-01-01')];
    const drawn = drawOldestFirst(lots, 'h', new Decimal('1'));
    expect(drawn[0]?.cost.toString()).toBe('100');
  });
});

describe('tax days are London days', () => {
  test('an instant in the last hour of a UTC day in summer is the NEXT tax day', () => {
    // 23:00 UTC on 30 June is 00:00 on 1 July under British Summer Time. Both
    // HMRC rules count calendar days, and the calendar a UK return is filed
    // against is this one.
    expect(taxDayKey(new Date('2023-06-30T23:00:00Z'))).toBe('2023-07-01');
    expect(taxDayKey(new Date('2023-06-30T22:59:59Z'))).toBe('2023-06-30');
  });

  test('and in winter it is not, because there is no offset to apply', () => {
    expect(taxDayKey(new Date('2023-12-30T23:00:00Z'))).toBe('2023-12-30');
  });

  test('the 30-day window ends 30 days after, inclusive', () => {
    expect(taxDaysBetween('2009-02-28', '2009-03-30')).toBe(BED_AND_BREAKFAST_DAYS);
    expect(taxDaysBetween('2009-02-28', '2009-03-31')).toBe(BED_AND_BREAKFAST_DAYS + 1);
    // Across a BST transition, where the elapsed hours are not a multiple of 24.
    expect(taxDaysBetween('2023-03-25', '2023-03-27')).toBe(2);
  });
});

describe('planSection104Matches', () => {
  test('same day is settled for every disposal before any 30-day match is made', () => {
    // The 5 June acquisition is reachable two ways: same-day by the 5 June
    // disposal, and inside the 30-day window of the 1 June one. Same day wins,
    // and a single pass in disposal order would let 1 June take it first.
    const acquisitions = [
      {
        txId: 'a',
        holdingId: 'h',
        occurredAt: new Date('2023-06-05T10:00:00Z'),
        qty: new Decimal('10'),
      },
    ];
    const disposals = [
      {
        key: 'd1#0',
        holdingId: 'h',
        occurredAt: new Date('2023-06-01T10:00:00Z'),
        qty: new Decimal('10'),
      },
      {
        key: 'd2#0',
        holdingId: 'h',
        occurredAt: new Date('2023-06-05T15:00:00Z'),
        qty: new Decimal('10'),
      },
    ];
    const plan = planSection104Matches(acquisitions, disposals);

    expect(plan.forward.get('d1#0')).toBeUndefined();
    expect(plan.forward.get('d2#0')?.[0]?.qty.toString()).toBe('10');
    expect(plan.reserved.get('a')?.toString()).toBe('10');
  });

  test('never matches across holdings', () => {
    const plan = planSection104Matches(
      [
        {
          txId: 'a',
          holdingId: 'other',
          occurredAt: new Date('2023-06-02T10:00:00Z'),
          qty: new Decimal('10'),
        },
      ],
      [
        {
          key: 'd#0',
          holdingId: 'h',
          occurredAt: new Date('2023-06-01T10:00:00Z'),
          qty: new Decimal('10'),
        },
      ]
    );
    expect(plan.forward.size).toBe(0);
    expect(plan.reserved.size).toBe(0);
  });

  test('reserves no more than the disposal asked for or the acquisition holds', () => {
    const plan = planSection104Matches(
      [
        {
          txId: 'a',
          holdingId: 'h',
          occurredAt: new Date('2023-06-02T10:00:00Z'),
          qty: new Decimal('3'),
        },
      ],
      [
        {
          key: 'd#0',
          holdingId: 'h',
          occurredAt: new Date('2023-06-01T10:00:00Z'),
          qty: new Decimal('10'),
        },
      ]
    );
    expect(plan.reserved.get('a')?.toString()).toBe('3');
    expect(
      plan.forward
        .get('d#0')
        ?.reduce((s, m) => s.add(m.qty), new Decimal(0))
        .toString()
    ).toBe('3');
  });
});
