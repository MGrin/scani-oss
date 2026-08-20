import { describe, expect, test } from 'bun:test';
import {
  CreateHoldingsWithDependenciesDto,
  collidingHoldingTokens,
  contestedHoldingTokens,
  holdingPositionKey,
} from '../../src/dtos/batch';

describe('CreateHoldingsWithDependenciesDto validation', () => {
  test('should accept valid holdings data', () => {
    const validData = {
      accountId: '550e8400-e29b-41d4-a716-446655440000',
      holdings: [
        {
          tokenId: '550e8400-e29b-41d4-a716-446655440001',
          balance: '123.45',
        },
        {
          tokenId: '550e8400-e29b-41d4-a716-446655440002',
          balance: '0.001',
        },
      ],
    };

    const result = CreateHoldingsWithDependenciesDto.safeParse(validData);
    expect(result.success).toBe(true);
  });

  test('should accept valid balance formats', () => {
    const validBalances = ['0', '1.0', '123.456', '0.001', '1000000'];

    for (const balance of validBalances) {
      const data = {
        holdings: [
          {
            tokenId: '550e8400-e29b-41d4-a716-446655440001',
            balance,
          },
        ],
      };

      const result = CreateHoldingsWithDependenciesDto.safeParse(data);
      expect(result.success).toBe(true);
    }
  });

  test('should reject invalid balance values', () => {
    const invalidBalances = ['abc', 'NaN', 'Infinity', '-Infinity', '12.34.56', '1,000', ''];

    for (const balance of invalidBalances) {
      const data = {
        holdings: [
          {
            tokenId: '550e8400-e29b-41d4-a716-446655440001',
            balance,
          },
        ],
      };

      const result = CreateHoldingsWithDependenciesDto.safeParse(data);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.path).toContain('balance');
      }
    }
  });

  test('should reject negative balance', () => {
    const data = {
      holdings: [
        {
          tokenId: '550e8400-e29b-41d4-a716-446655440001',
          balance: '-5',
        },
      ],
    };

    const result = CreateHoldingsWithDependenciesDto.safeParse(data);
    expect(result.success).toBe(false);
  });

  test('should require at least one holding', () => {
    const data = {
      holdings: [],
    };

    const result = CreateHoldingsWithDependenciesDto.safeParse(data);
    expect(result.success).toBe(false);
  });
});

/**
 * SC-330. The rule that decides whether an account may hold several rows for
 * one token, tested here because THREE surfaces refuse on it — the screenshot
 * review card, the v3 manual-entry form, and the use case behind both. They
 * used to hold three copies of it, and a form that refuses less than the
 * server refuses is a form that submits and then fails the job.
 *
 ***REMOVED***
 ***REMOVED***
 ***REMOVED***
 ***REMOVED***
 */
describe('holdingPositionKey', () => {
  test('an absent name is not a wildcard — it is the empty name', () => {
    expect(holdingPositionKey('rub')).toBe(holdingPositionKey('rub', ''));
    expect(holdingPositionKey('rub')).toBe(holdingPositionKey('rub', null));
  });

  test('names are compared without case or surrounding space', () => {
    expect(holdingPositionKey('rub', 'Savings')).toBe(holdingPositionKey('rub', ' savings '));
  });

  test('the token is part of the key, so one name serves several tokens', () => {
    expect(holdingPositionKey('rub', 'Savings')).not.toBe(holdingPositionKey('usd', 'Savings'));
  });

  test('the join cannot be forged out of the parts', () => {
    // A separator that can occur inside a name lets ("rub", "a|b") and
    // ("rub|a", "b") collapse into one key, which would silently merge two
    // positions. NUL cannot survive a trimmed label.
    expect(holdingPositionKey('rub', 'a b')).not.toBe(holdingPositionKey('rub a', 'b'));
  });
});

describe('contestedHoldingTokens — which rows get asked to name themselves', () => {
  test('a token on two create rows is contested', () => {
    expect([...contestedHoldingTokens([{ tokenId: 'rub' }, { tokenId: 'rub' }])]).toEqual(['rub']);
  });

  test('a create beside an update of the same token is contested', () => {
    expect([...contestedHoldingTokens([{ tokenId: 'rub' }], [{ tokenId: 'rub' }])]).toEqual([
      'rub',
    ]);
  });

  test('a token on one row is never asked', () => {
    // The question appears only where there is something to answer. A confirm
    // that shows up every time stops being read (SC-63, SC-73).
    expect([...contestedHoldingTokens([{ tokenId: 'rub' }, { tokenId: 'usd' }])]).toEqual([]);
  });

  test('it stays contested after the names are filled in', () => {
    // Label-blind on purpose. Deriving this from the unresolved collision
    // makes the name field vanish the moment the first name is typed, taking
    // the other rows' fields with it.
    const named = [
      { tokenId: 'rub', label: 'Savings' },
      { tokenId: 'rub', label: 'Deposit' },
    ];
    expect([...contestedHoldingTokens(named)]).toEqual(['rub']);
  });
});

describe('collidingHoldingTokens — which rows are still refused', () => {
  test('two unnamed rows for one token still collide', () => {
    // The SC-303 defect itself, unchanged. Someone who typed RUB twice by
    // accident is stopped exactly as they were before this ticket.
    expect([...collidingHoldingTokens([{ tokenId: 'rub' }, { tokenId: 'rub' }])]).toEqual(['rub']);
  });

  test('the Tinkoff four are allowed once each pot is named', () => {
    const pots = [
      { tokenId: 'rub', label: 'Current' },
      { tokenId: 'rub', label: 'Savings' },
      { tokenId: 'rub', label: 'Deposit' },
      { tokenId: 'rub', label: 'Cashback' },
    ];
    expect([...collidingHoldingTokens(pots)]).toEqual([]);
  });

  test('the same name on two rows expresses nothing and still collides', () => {
    const same = [
      { tokenId: 'rub', label: 'Savings' },
      { tokenId: 'rub', label: ' savings ' },
    ];
    expect([...collidingHoldingTokens(same)]).toEqual(['rub']);
  });

  test('naming some but not all leaves the unnamed ones colliding', () => {
    const partial = [{ tokenId: 'rub', label: 'Savings' }, { tokenId: 'rub' }, { tokenId: 'rub' }];
    expect([...collidingHoldingTokens(partial)]).toEqual(['rub']);
  });

  test('a named pot may join an account whose existing row has no name', () => {
    // Production's own shape: the four RUB rows carry no label at all.
    // Requiring every existing row to be renamed first would leave that
    // account unable to add the fifth pot it opens next.
    expect([
      ...collidingHoldingTokens([{ tokenId: 'rub', label: 'Deposit' }], [{ tokenId: 'rub' }]),
    ]).toEqual([]);
  });

  test('an unnamed row still collides with the unnamed row already held', () => {
    expect([...collidingHoldingTokens([{ tokenId: 'rub' }], [{ tokenId: 'rub' }])]).toEqual([
      'rub',
    ]);
  });

  test('one name may serve two different tokens', () => {
    // "Savings" on the RUB row and "Savings" on the USD row are two positions
    // in two currencies — the ordinary case on a multi-currency bank screen.
    const perToken = [
      { tokenId: 'rub', label: 'Savings' },
      { tokenId: 'usd', label: 'Savings' },
    ];
    expect([...collidingHoldingTokens(perToken)]).toEqual([]);
  });
});
