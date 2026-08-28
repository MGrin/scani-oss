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
    // SC-625's default, restated in the fixture rather than inherited: every
    // test in this file that does not name it is asserting the behaviour of a
    // book where nobody opted in, which is what the option being opt-in means.
    estimateFromHistory: false,
    ...overrides,
  };
}

/** Materialised `scheduled` rows on the 15th of each named month. */
function scheduledOn(months: readonly string[], expectedAmount: string | null = '100') {
  return months.map((month) => ({
    dueDate: `${month}-15`,
    status: 'scheduled',
    expectedAmount,
    actualAmount: null,
  }));
}

/** Settled rows: `matched` with a recorded actual, the pair SC-625 reads. */
function settledOn(entries: readonly (readonly [month: string, actualAmount: string])[]) {
  return entries.map(([month, actualAmount]) => ({
    dueDate: `${month}-15`,
    status: 'matched',
    expectedAmount: null,
    actualAmount,
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
      { dueDate: '2026-03-15', status: 'scheduled', expectedAmount: '100', actualAmount: null },
      { dueDate: '2026-04-15', status: 'skipped', expectedAmount: '100', actualAmount: null },
      { dueDate: '2026-05-15', status: 'scheduled', expectedAmount: '100', actualAmount: null },
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
      { dueDate: '2026-09-15', status: 'scheduled', expectedAmount: '100', actualAmount: null },
      { dueDate: '2026-10-15', status: 'matched', expectedAmount: '100', actualAmount: null },
    ];
    const forecast = buildForecast([input({}, rows)], TODAY, '2026-11-01');

    expect(forecast.movements.map((movement) => movement.dueDate)).toEqual(['2026-09-15']);
  });

  test('a matched occurrence is money that already moved and is not projected', () => {
    const rows = [
      { dueDate: '2026-03-15', status: 'matched', expectedAmount: '100', actualAmount: null },
      { dueDate: '2026-04-15', status: 'scheduled', expectedAmount: '100', actualAmount: null },
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
    expect(forecast.unprojectable).toEqual([
      { paymentId: 'variable', direction: 'outflow', lastSettled: null },
    ]);
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
    expect(forecast.unprojectable).toEqual([
      { paymentId: 'pay-1', direction: 'outflow', lastSettled: null },
    ]);
  });
});

describe('buildForecast — overdue is not absorbed by the window', () => {
  test('a bill already past due is reported separately, not folded into month one', () => {
    const rows = [
      { dueDate: '2026-01-15', status: 'scheduled', expectedAmount: '100', actualAmount: null },
      { dueDate: '2026-02-15', status: 'scheduled', expectedAmount: '100', actualAmount: null },
      { dueDate: '2026-03-15', status: 'scheduled', expectedAmount: '100', actualAmount: null },
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
    const rows = [
      { dueDate: '2026-03-15', status: 'scheduled', expectedAmount: '175.50', actualAmount: null },
    ];
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

describe('buildForecast — estimating from settled history (SC-625)', () => {
  // The book every test below varies from: a variable payment with no
  // estimate, three settled months behind it, and nothing projected. This is
  // SC-461's behaviour and it is the DEFAULT, so it is asserted first — if the
  // option ever stopped being opt-in, this is the test that goes red.
  const HISTORY = settledOn([
    ['2025-12', '80.00'],
    ['2026-01', '92.40'],
    ['2026-02', '84.20'],
  ]);
  const AHEAD = scheduledOn(['2026-03', '2026-04'], null);

  test('history is NOT used unless the payment says so', () => {
    const forecast = buildForecast(
      [input({ id: 'power', expectedAmount: null }, [...HISTORY, ...AHEAD])],
      TODAY,
      '2026-05-01'
    );

    expect(forecast.movements).toEqual([]);
    expect(forecast.estimatedFromHistory).toEqual([]);
    expect(forecast.unprojectable).toEqual([
      {
        paymentId: 'power',
        direction: 'outflow',
        // Reported even though the option is OFF: the surface has to know
        // that turning it on would do something here.
        lastSettled: { amount: '84.20', dueDate: '2026-02-15' },
      },
    ]);
  });

  test('with the opt-in on, the LAST settled amount prices the payment', () => {
    const forecast = buildForecast(
      [
        input({ id: 'power', expectedAmount: null, estimateFromHistory: true }, [
          ...HISTORY,
          ...AHEAD,
        ]),
      ],
      TODAY,
      '2026-05-01'
    );

    // 84.20, February's — not 92.40 (the largest), not 85.53 (the mean).
    // A single settled period is a figure that happened; an average is a new
    // number nobody has ever paid.
    expect(forecast.movements.map((movement) => movement.amount)).toEqual(['84.20', '84.20']);
    expect(forecast.movements.every((movement) => movement.basis === 'history')).toBe(true);
    expect(forecast.estimatedFromHistory).toEqual([
      {
        paymentId: 'power',
        direction: 'outflow',
        currencyTokenId: 'eur',
        amount: '84.20',
        sourceDueDate: '2026-02-15',
      },
    ]);
  });

  test('THE COUNT STAYS: opted in with nothing settled is still unprojectable', () => {
    // The opt-in is permission to use history, not a claim that history
    // exists. A book where every variable payment is opted in and none has
    // settled must report exactly what it reported before.
    const forecast = buildForecast(
      [input({ id: 'new-bill', expectedAmount: null, estimateFromHistory: true }, AHEAD)],
      TODAY,
      '2026-05-01'
    );

    expect(forecast.movements).toEqual([]);
    expect(forecast.estimatedFromHistory).toEqual([]);
    expect(forecast.unprojectable).toEqual([
      // Opted in, nothing settled: still counted, and `lastSettled: null` is
      // what tells the surface no button can help.
      { paymentId: 'new-bill', direction: 'outflow', lastSettled: null },
    ]);
  });

  test('a skipped row is never the source, however recent, and a matched row with no actual is not either', () => {
    // Two rows that a laxer rule would take. `skipped` is a decision NOT to
    // pay — the worst possible basis for projecting the next one — and
    // `matched` with no recorded actual says a transaction was linked, not
    // what moved.
    const poisoned = [
      ...HISTORY,
      { dueDate: '2026-02-20', status: 'skipped', expectedAmount: null, actualAmount: '999.00' },
      { dueDate: '2026-02-25', status: 'matched', expectedAmount: null, actualAmount: null },
    ];
    const forecast = buildForecast(
      [input({ id: 'power', expectedAmount: null, estimateFromHistory: true }, poisoned)],
      TODAY,
      '2026-04-01'
    );

    expect(forecast.estimatedFromHistory[0]?.amount).toBe('84.20');

    // The must-be-FOUND control on the same axis: the SAME two dates, settled
    // properly, DO win. Without it the assertion above passes on a rule that
    // ignores late rows entirely rather than on one that reads their status.
    const settled = [
      ...HISTORY,
      { dueDate: '2026-02-25', status: 'matched', expectedAmount: null, actualAmount: '999.00' },
    ];
    const control = buildForecast(
      [input({ id: 'power', expectedAmount: null, estimateFromHistory: true }, settled)],
      TODAY,
      '2026-04-01'
    );
    expect(control.estimatedFromHistory[0]?.amount).toBe('999.00');
  });

  test('a declared amount always beats history, and the basis says which was used', () => {
    // The mixed book the whole `basis` field exists for: March carries an
    // amount somebody entered, April does not. One payment, two registers.
    const mixed = [
      { dueDate: '2026-03-15', status: 'scheduled', expectedAmount: '150.00', actualAmount: null },
      { dueDate: '2026-04-15', status: 'scheduled', expectedAmount: null, actualAmount: null },
    ];
    const forecast = buildForecast(
      [
        input({ id: 'power', expectedAmount: null, estimateFromHistory: true }, [
          ...HISTORY,
          ...mixed,
        ]),
      ],
      TODAY,
      '2026-05-01'
    );

    expect(
      forecast.movements.map((movement) => [movement.dueDate, movement.amount, movement.basis])
    ).toEqual([
      ['2026-03-15', '150.00', 'declared'],
      ['2026-04-15', '84.20', 'history'],
    ]);
    // Reported, because part of this payment's projection rests on history —
    // and the surface has to be able to say so about the April figure.
    expect(forecast.estimatedFromHistory.map((entry) => entry.paymentId)).toEqual(['power']);
  });

  test('a payment fully priced by its own estimate is not reported as estimated, opt-in or not', () => {
    // The must-be-ABSENT half: the flag is ON and history EXISTS, and nothing
    // is estimated, because nothing needed to be. A report keyed on the flag
    // rather than on the substitution would name this payment.
    const forecast = buildForecast(
      [input({ id: 'rent', expectedAmount: '1200', estimateFromHistory: true }, HISTORY)],
      TODAY,
      '2026-05-01'
    );

    expect(forecast.movements.every((movement) => movement.basis === 'declared')).toBe(true);
    expect(forecast.estimatedFromHistory).toEqual([]);
  });

  test('a quarterly payment takes its last settled QUARTER, unscaled', () => {
    // "Last month" has no referent here. The last settled period is on the
    // payment's own cadence, so a quarterly water bill is projected at what a
    // quarter actually cost — never a third of it, and never three times it.
    const forecast = buildForecast(
      [
        input(
          {
            id: 'water',
            expectedAmount: null,
            estimateFromHistory: true,
            intervalUnit: 'quarter',
            anchorDate: '2025-12-15',
          },
          settledOn([['2025-12', '210.00']])
        ),
      ],
      TODAY,
      '2026-07-01'
    );

    expect(forecast.movements.map((movement) => [movement.dueDate, movement.amount])).toEqual([
      ['2026-03-15', '210.00'],
      ['2026-06-15', '210.00'],
    ]);
  });

  test('an overdue movement priced from history is still overdue, not folded into the window', () => {
    const forecast = buildForecast(
      [
        input({ id: 'power', expectedAmount: null, estimateFromHistory: true }, [
          ...HISTORY,
          ...scheduledOn(['2026-02'], null),
        ]),
      ],
      TODAY,
      '2026-04-01'
    );

    expect(forecast.overdue.map((movement) => [movement.dueDate, movement.basis])).toEqual([
      ['2026-02-15', 'history'],
    ]);
    expect(forecast.movements.every((movement) => movement.dueDate >= TODAY)).toBe(true);
  });
});
