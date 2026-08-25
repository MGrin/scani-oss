import { describe, expect, test } from 'bun:test';
import {
  type MovementHolding,
  matchMovementHoldings,
  movementBlockerKeys,
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
