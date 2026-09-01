import { describe, expect, test } from 'bun:test';
import {
  type MovementHolding,
  matchMovementHoldings,
  movementBlockerKeys,
  movementFeeArrival,
  movementHoldingLabel,
  movementHoldingSelectedLabel,
} from '@/v3/lib/movement-form';

/**
 * The searched holding field and the submit gate (SC-619).
 *
 * mgrin's words are the spec — *"that should be a searchable field that searches
 * through institutions, accounts and holdings"* — and all three of those are
 * asserted separately below, because a search that spans two of them looks
 * exactly like one that spans three until the third is the thing you typed.
 */

function holding(overrides: Partial<MovementHolding> & { id: string }): MovementHolding {
  return {
    amount: '1000',
    token: { symbol: 'USD', name: 'US Dollar' },
    account: { name: 'Main' },
    institution: { id: 'inst-1', name: 'Kraken', website: 'kraken.com' },
    ...overrides,
  };
}

const PORTFOLIO: MovementHolding[] = [
  holding({
    id: 'kraken-btc',
    token: { symbol: 'BTC', name: 'Bitcoin' },
    account: { name: 'Spot' },
    institution: { id: 'kraken', name: 'Kraken', website: 'kraken.com' },
  }),
  holding({
    id: 'kraken-usd',
    token: { symbol: 'USD', name: 'US Dollar' },
    account: { name: 'Spot' },
    institution: { id: 'kraken', name: 'Kraken', website: 'kraken.com' },
  }),
  holding({
    id: 'tinkoff-rub',
    token: { symbol: 'RUB', name: 'Russian Ruble' },
    account: { name: 'Current' },
    institution: { id: 'tinkoff', name: 'Tinkoff', website: 'tinkoff.ru' },
  }),
  holding({
    id: 'tinkoff-rub-savings',
    label: 'Holiday pot',
    token: { symbol: 'RUB', name: 'Russian Ruble' },
    account: { name: 'Savings' },
    institution: { id: 'tinkoff', name: 'Tinkoff', website: 'tinkoff.ru' },
  }),
];

const ids = (rows: readonly MovementHolding[]) => rows.map((row) => row.id);

describe('matchMovementHoldings', () => {
  test('an institution surfaces its accounts and their holdings', () => {
    expect(ids(matchMovementHoldings(PORTFOLIO, 'tinkoff'))).toEqual([
      'tinkoff-rub',
      'tinkoff-rub-savings',
    ]);
  });

  test('an account name matches', () => {
    expect(ids(matchMovementHoldings(PORTFOLIO, 'savings'))).toEqual(['tinkoff-rub-savings']);
  });

  test('a token symbol matches, and so does the token name nobody sees', () => {
    expect(ids(matchMovementHoldings(PORTFOLIO, 'btc'))).toEqual(['kraken-btc']);
    expect(ids(matchMovementHoldings(PORTFOLIO, 'bitcoin'))).toEqual(['kraken-btc']);
  });

  test("a holding's own pot name matches", () => {
    expect(ids(matchMovementHoldings(PORTFOLIO, 'holiday'))).toEqual(['tinkoff-rub-savings']);
  });

  /** The must-be-ABSENT control: a query naming nothing must return nothing,
   *  or every assertion above passes on a filter that never filters. */
  test('a query that names nothing returns nothing', () => {
    expect(matchMovementHoldings(PORTFOLIO, 'coinbase')).toHaveLength(0);
  });

  test('terms narrow rather than widen — every one has to match', () => {
    expect(ids(matchMovementHoldings(PORTFOLIO, 'kraken usd'))).toEqual(['kraken-usd']);
    expect(matchMovementHoldings(PORTFOLIO, 'kraken rub')).toHaveLength(0);
  });

  test('an empty query is the whole list, by institution then account then pot', () => {
    expect(ids(matchMovementHoldings(PORTFOLIO, '  '))).toEqual([
      'kraken-btc',
      'kraken-usd',
      'tinkoff-rub',
      'tinkoff-rub-savings',
    ]);
  });

  /**
   * What the ranking is FOR: with a cap, insertion order decides which rows a
   * reader ever sees. `rub` names the token, so the two RUB rows have to come
   * before an institution that merely contains those letters.
   */
  test('a token match outranks an institution that merely contains the letters', () => {
    const rows = [
      ...PORTFOLIO,
      holding({
        id: 'rubicon-usd',
        account: { name: 'Trading' },
        institution: { id: 'rubicon', name: 'Rubicon', website: null },
      }),
    ];
    expect(ids(matchMovementHoldings(rows, 'rub'))).toEqual([
      'tinkoff-rub',
      'tinkoff-rub-savings',
      'rubicon-usd',
    ]);
  });

  test('the cap is honoured', () => {
    expect(matchMovementHoldings(PORTFOLIO, '', 2)).toHaveLength(2);
  });
});

describe('the row and the chosen value', () => {
  test('a row reads as the pot in its account; the institution is its hint', () => {
    expect(movementHoldingLabel(PORTFOLIO[3] as MovementHolding)).toBe('Holiday pot · Savings');
    expect(movementHoldingLabel(PORTFOLIO[0] as MovementHolding)).toBe('BTC · Spot');
  });

  /** The chosen holding is shown alone — no favicon, no hint — so the one line
   *  it gets has to name the institution too. */
  test('the chosen value carries the institution the row put in its hint', () => {
    expect(movementHoldingSelectedLabel(PORTFOLIO[0] as MovementHolding)).toBe(
      'BTC · Spot · Kraken'
    );
  });
});

describe('movementBlockerKeys', () => {
  const complete = {
    holdingId: 'kraken-btc',
    direction: 'outflow' as const,
    amount: '12.5',
    destination: 'left_control' as const,
  };

  test('nothing missing', () => {
    expect(movementBlockerKeys(complete)).toEqual([]);
  });

  test('names the holding, the amount and the unanswered question', () => {
    expect(
      movementBlockerKeys({ ...complete, holdingId: '', amount: '', destination: null })
    ).toEqual([
      'v3.holdings.movement.blocker.holding',
      'v3.holdings.movement.blocker.amount',
      'v3.holdings.movement.blocker.where',
    ]);
  });

  test('zero and a negative are not amounts', () => {
    expect(movementBlockerKeys({ ...complete, amount: '0' })).toEqual([
      'v3.holdings.movement.blocker.amount',
    ]);
    expect(movementBlockerKeys({ ...complete, amount: '-3' })).toEqual([
      'v3.holdings.movement.blocker.amount',
    ]);
  });

  /** An inflow is not asked where it went, so the absent answer is not a
   *  blocker — the shape SC-607 verified and this ticket must not change. */
  test('an inflow needs no destination', () => {
    expect(movementBlockerKeys({ ...complete, direction: 'inflow', destination: null })).toEqual(
      []
    );
  });

  /** A transfer's destination account is `describeAccountTargetBlockers`, not
   *  this — see the docblock. */
  test('a transfer adds no destination blocker of its own', () => {
    expect(
      movementBlockerKeys({ ...complete, direction: 'transfer', destination: 'transfer' })
    ).toEqual([]);
  });
});

/**
 * The fee, on the form that could not state one until SC-889.
 *
 * Held here rather than by a rendered assertion for the reason this module's
 * docblock gives, and for a second one this ticket measured: `RecordMovementSheet`
 * is a Radix sheet and Radix renders nothing under `renderToStaticMarkup`, so
 * the same gap that left `HoldingEditCauseDialog`'s fee field covered by
 * type-check alone would apply here. The rules are pure, so they are testable;
 * the rendering was exercised in a real browser instead.
 */
describe('the transfer fee', () => {
  const transfer = {
    holdingId: 'kraken-btc',
    direction: 'transfer' as const,
    amount: '251.33',
    destination: 'transfer' as const,
  };

  test('what arrives is what left minus the fee', () => {
    expect(movementFeeArrival({ ...transfer, fee: '1.33' })).toBe('250');
    expect(movementBlockerKeys({ ...transfer, fee: '1.33' })).toEqual([]);
  });

  test('no fee stated is not a fee of zero — there is no arrival figure to show', () => {
    expect(movementFeeArrival({ ...transfer, fee: '' })).toBeNull();
    expect(movementFeeArrival({ ...transfer, fee: '  ' })).toBeNull();
    expect(movementFeeArrival(transfer)).toBeNull();
    // And none of them is a blocker: a transfer that cost nothing is the
    // common case and must stay submittable.
    expect(movementBlockerKeys({ ...transfer, fee: '' })).toEqual([]);
  });

  /**
   * The refusal, through `feeFitsMovement` rather than a second spelling of it
   * — so the button and `ManualBalanceEditService` cannot disagree about what
   * fits. Equal is refused as well as larger: a fee equal to the whole movement
   * leaves nothing to transfer.
   */
  test('a fee that is not smaller than the movement blocks the submit', () => {
    expect(movementBlockerKeys({ ...transfer, fee: '251.33' })).toEqual([
      'v3.holdings.movement.blocker.fee',
    ]);
    expect(movementBlockerKeys({ ...transfer, fee: '300' })).toEqual([
      'v3.holdings.movement.blocker.fee',
    ]);
    expect(movementFeeArrival({ ...transfer, fee: '251.33' })).toBeNull();
  });

  /**
   * The must-be-ABSENT control, and the reason `movementFeeStated` reads the
   * direction rather than only the field. Typing a fee and then flipping the
   * control back to `outflow` leaves the value in state with the input gone; if
   * the direction were not read, Save would be disabled with nothing on screen
   * saying why, and the fee would ride out on a movement with no second leg.
   */
  test('a fee left behind by switching away from a transfer counts for nothing', () => {
    const outflow = {
      ...transfer,
      direction: 'outflow' as const,
      destination: 'untracked' as const,
      fee: '300',
    };
    expect(movementBlockerKeys(outflow)).toEqual([]);
    expect(movementFeeArrival(outflow)).toBeNull();
    expect(movementFeeArrival({ ...outflow, direction: 'inflow' as const })).toBeNull();
  });

  /** An unparseable amount has no arrival to compute, and must not throw. */
  test('a fee against an amount that is not a number is refused, not thrown on', () => {
    expect(movementFeeArrival({ ...transfer, amount: '', fee: '1.33' })).toBeNull();
    expect(movementFeeArrival({ ...transfer, amount: 'abc', fee: '1.33' })).toBeNull();
    expect(movementFeeArrival({ ...transfer, amount: '251.33', fee: 'abc' })).toBeNull();
  });
});
