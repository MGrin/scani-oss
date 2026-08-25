import { describe, expect, test } from 'bun:test';
import {
  buildForecast,
  type ForecastPayment,
  type ForecastPaymentInput,
} from '../../../src/services/payments/forecast';

// `buildForecast` is the only thing standing between a book of recurring
// payments and a number the reader will plan their year around, so every
// test here asserts the MONEY — the dated amounts that come out — rather
// than that a code path ran. Pure function, fixed dates, no clock.

const TODAY = '2026-03-01';
const HORIZON = '2027-03-01';

function payment(overrides: Partial<ForecastPayment> = {}): ForecastPayment {
  return {
    id: 'pay-1',
    direction: 'outflow',
    currencyTokenId: 'eur',
    expectedAmount: '100',
    intervalUnit: 'month',
    intervalCount: 1,
    anchorDate: '2026-01-15',
    status: 'active',
    endDate: null,
    ...overrides,
  };
}

/** Materialised `scheduled` rows on the 15th of each named month. */
function scheduledOn(months: readonly string[], expectedAmount: string | null = '100') {
  return months.map((month) => ({
    dueDate: `${month}-15`,
    status: 'scheduled',
    expectedAmount,
  }));
}

function input(
  paymentOverrides: Partial<ForecastPayment> = {},
  occurrences: ForecastPaymentInput['occurrences'] = []
): ForecastPaymentInput {
  return { payment: payment(paymentOverrides), occurrences };
}

function totalOf(movements: readonly { amount: string }[]): number {
  return movements.reduce((sum, movement) => sum + Number(movement.amount), 0);
}

describe('buildForecast — the pause constraint (SC-47, SC-48)', () => {
  // `PaymentService.pause` writes status + pausedAt and deliberately DELETES
  // NOTHING, so a paused payment's future `scheduled` rows are still sitting
  // in the table. A projection reading occurrences without the owning
  // payment's status projects a paused bill at full value with database rows
  // to back it up — the reason this is the first test in the file.
  test('a paused payment contributes nothing, though its scheduled rows still exist', () => {
    const rows = scheduledOn(['2026-03', '2026-04', '2026-05']);
    const paused = buildForecast([input({ status: 'paused' }, rows)], TODAY, HORIZON);

    expect(paused.movements).toEqual([]);
    expect(paused.overdue).toEqual([]);
    expect(paused.unprojectable).toEqual([]);

    // The control: the SAME rows on an ACTIVE payment do project. Without
    // this the assertion above passes on a function that returns nothing at
    // all — the must-be-FOUND half of the pair.
    const active = buildForecast([input({ status: 'active' }, rows)], TODAY, HORIZON);
    expect(active.movements.length).toBeGreaterThan(0);
    expect(totalOf(active.movements.filter((m) => m.origin === 'materialised'))).toBe(300);
  });

  test('an ended payment contributes nothing', () => {
    const ended = buildForecast(
      [input({ status: 'ended' }, scheduledOn(['2026-03', '2026-04']))],
      TODAY,
      HORIZON
    );
    expect(ended.movements).toEqual([]);
  });
});

describe('buildForecast — past the materialised edge', () => {
  // MATERIALISATION_HORIZON_MONTHS fills 12 months forward from the day a
  // payment was last WRITTEN, and no scheduled job refreshes it. A payment
  // untouched for five months has rows seven months out; a twelve-month
  // projection off the table alone would taper to zero there and read as a
  // cost that ends.
  test('the rule fills the months the occurrence table has decayed past', () => {
    const rows = scheduledOn([
      '2026-03',
      '2026-04',
      '2026-05',
      '2026-06',
      '2026-07',
      '2026-08',
      '2026-09',
      '2026-10',
    ]);
    const forecast = buildForecast([input({}, rows)], TODAY, HORIZON);

    // Eight materialised + the rule carrying on Nov..Feb, and one more on
    // 2027-03-15? No: the horizon is 2027-03-01, so the last date is
    // 2027-02-15. Twelve €100 due dates, no gap and no double-count.
    expect(forecast.movements).toHaveLength(12);
    expect(totalOf(forecast.movements)).toBe(1200);

    const dates = forecast.movements.map((movement) => movement.dueDate);
    expect(new Set(dates).size).toBe(12);
    expect(dates.at(-1)).toBe('2027-02-15');
    expect(forecast.movements.filter((movement) => movement.origin === 'rule')).toHaveLength(4);
  });

  test('a payment with no materialised rows at all is projected entirely from the rule', () => {
    const forecast = buildForecast([input({}, [])], TODAY, HORIZON);
    expect(forecast.movements).toHaveLength(12);
    expect(forecast.movements[0]?.dueDate).toBe('2026-03-15');
    expect(forecast.movements.every((movement) => movement.origin === 'rule')).toBe(true);
  });

  test('a skipped date is not projected and the rule does not regenerate it', () => {
    // The edge is taken over EVERY row, not the scheduled ones, so a skip
    // inside the materialised window stays skipped instead of coming back as
    // a rule-generated date.
    const rows = [
      { dueDate: '2026-03-15', status: 'scheduled', expectedAmount: '100' },
      { dueDate: '2026-04-15', status: 'skipped', expectedAmount: '100' },
      { dueDate: '2026-05-15', status: 'scheduled', expectedAmount: '100' },
    ];
    const forecast = buildForecast([input({}, rows)], TODAY, '2026-06-01');

    expect(forecast.movements.map((movement) => movement.dueDate)).toEqual([
      '2026-03-15',
      '2026-05-15',
    ]);
  });

  test('the rule does not re-bill a date whose only row is already settled', () => {
    // The edge is the max over EVERY row. Taken over the `scheduled` ones
    // alone it would sit on 2026-09-15 here, and the rule would regenerate
    // 2026-10-15 — a second charge for a bill the reader has already paid,
    // in the month it was paid. The skip case above cannot see this: it has
    // scheduled rows AFTER the skip, so both readings of the edge agree.
    const rows = [
      { dueDate: '2026-09-15', status: 'scheduled', expectedAmount: '100' },
      { dueDate: '2026-10-15', status: 'matched', expectedAmount: '100' },
    ];
    const forecast = buildForecast([input({}, rows)], TODAY, '2026-11-01');

    expect(forecast.movements.map((movement) => movement.dueDate)).toEqual(['2026-09-15']);
  });

  test('a matched occurrence is money that already moved and is not projected', () => {
    const rows = [
      { dueDate: '2026-03-15', status: 'matched', expectedAmount: '100' },
      { dueDate: '2026-04-15', status: 'scheduled', expectedAmount: '100' },
    ];
    const forecast = buildForecast([input({}, rows)], TODAY, '2026-05-01');
    expect(forecast.movements.map((movement) => movement.dueDate)).toEqual(['2026-04-15']);
  });

  test('endDate truncates the rule as well as the table', () => {
    const forecast = buildForecast([input({ endDate: '2026-06-30' }, [])], TODAY, HORIZON);
    expect(forecast.movements.map((movement) => movement.dueDate)).toEqual([
      '2026-03-15',
      '2026-04-15',
      '2026-05-15',
      '2026-06-15',
    ]);
  });
});

describe('buildForecast — what it will not guess', () => {
  test('a variable payment with no estimate is reported, never dropped and never invented', () => {
    const forecast = buildForecast(
      [input({ id: 'variable', expectedAmount: null }, scheduledOn(['2026-03', '2026-04'], null))],
      TODAY,
      HORIZON
    );

    expect(forecast.movements).toEqual([]);
    expect(forecast.unprojectable).toEqual([{ paymentId: 'variable', direction: 'outflow' }]);
  });

  test('an estimate filled in later prices the part it can and claims nothing about the rest', () => {
    // The payment now carries an estimate, so the rule prices its dates; the
    // already-materialised rows predate it and stay null. Calling the whole
    // payment unprojectable would be a claim about the priced half too.
    const forecast = buildForecast(
      [input({ expectedAmount: '250' }, scheduledOn(['2026-03', '2026-04'], null))],
      TODAY,
      '2026-07-01'
    );

    expect(forecast.unprojectable).toEqual([]);
    // The materialised rows fall back to the payment's own estimate.
    expect(totalOf(forecast.movements)).toBe(1000);
  });

  test('a cadence nobody can expand is reported rather than thrown on', () => {
    const forecast = buildForecast([input({ intervalUnit: 'fortnight' }, [])], TODAY, HORIZON);
    expect(forecast.movements).toEqual([]);
    expect(forecast.unprojectable).toEqual([{ paymentId: 'pay-1', direction: 'outflow' }]);
  });
});

describe('buildForecast — overdue is not absorbed by the window', () => {
  test('a bill already past due is reported separately, not folded into month one', () => {
    const rows = [
      { dueDate: '2026-01-15', status: 'scheduled', expectedAmount: '100' },
      { dueDate: '2026-02-15', status: 'scheduled', expectedAmount: '100' },
      { dueDate: '2026-03-15', status: 'scheduled', expectedAmount: '100' },
    ];
    const forecast = buildForecast([input({}, rows)], TODAY, '2026-04-01');

    expect(forecast.overdue.map((movement) => movement.dueDate)).toEqual([
      '2026-01-15',
      '2026-02-15',
    ]);
    expect(forecast.movements.map((movement) => movement.dueDate)).toEqual(['2026-03-15']);
  });
});

describe('buildForecast — the amounts a reader would see', () => {
  test("an occurrence's own amount beats the payment's estimate", () => {
    const rows = [{ dueDate: '2026-03-15', status: 'scheduled', expectedAmount: '175.50' }];
    const forecast = buildForecast([input({ expectedAmount: '100' }, rows)], TODAY, '2026-04-01');
    expect(forecast.movements[0]?.amount).toBe('175.50');
  });

  test('direction and currency travel with every movement, unsigned', () => {
    const forecast = buildForecast(
      [
        input({ id: 'rent', direction: 'outflow', currencyTokenId: 'eur', expectedAmount: '1200' }),
        input({
          id: 'invoice',
          direction: 'inflow',
          currencyTokenId: 'gbp',
          expectedAmount: '4000',
          intervalUnit: 'quarter',
        }),
      ],
      TODAY,
      '2026-05-01'
    );

    const rent = forecast.movements.filter((movement) => movement.paymentId === 'rent');
    const invoice = forecast.movements.filter((movement) => movement.paymentId === 'invoice');

    expect(rent.map((m) => m.amount)).toEqual(['1200', '1200']);
    expect(rent.every((m) => m.direction === 'outflow' && m.currencyTokenId === 'eur')).toBe(true);
    expect(invoice.map((m) => m.amount)).toEqual(['4000']);
    expect(invoice.every((m) => m.direction === 'inflow' && m.currencyTokenId === 'gbp')).toBe(
      true
    );
  });

  test('movements come back in date order across payments', () => {
    const forecast = buildForecast(
      [input({ id: 'a', anchorDate: '2026-03-20' }), input({ id: 'b', anchorDate: '2026-03-05' })],
      TODAY,
      '2026-04-01'
    );
    expect(forecast.movements.map((movement) => movement.dueDate)).toEqual([
      '2026-03-05',
      '2026-03-20',
    ]);
  });
});
