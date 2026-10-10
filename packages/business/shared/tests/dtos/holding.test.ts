import { describe, expect, test } from 'bun:test';
import { CreateHoldingsWithDependenciesDto } from '../../src/dtos/batch';
import { UpdateHoldingDto } from '../../src/dtos/holding';

describe('UpdateHoldingDto validation', () => {
  test('should accept valid balance', () => {
    const validData = {
      balance: '123.45',
    };

    const result = UpdateHoldingDto.safeParse(validData);
    expect(result.success).toBe(true);
  });

  test('should accept valid isActive value', () => {
    const validData = {
      isActive: true,
    };

    const result = UpdateHoldingDto.safeParse(validData);
    expect(result.success).toBe(true);
  });

  test('should accept both balance and isActive', () => {
    const validData = {
      balance: '123.45',
      isActive: false,
    };

    const result = UpdateHoldingDto.safeParse(validData);
    expect(result.success).toBe(true);
  });

  test('should accept empty object (optional fields)', () => {
    const validData = {};

    const result = UpdateHoldingDto.safeParse(validData);
    expect(result.success).toBe(true);
  });

  test('should reject invalid balance values', () => {
    const invalidBalances = ['abc', 'NaN', 'Infinity', '12.34.56', ''];

    for (const balance of invalidBalances) {
      const result = UpdateHoldingDto.safeParse({ balance });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.path).toContain('balance');
      }
    }
  });

  test('should reject invalid isActive values', () => {
    const invalidValues = ['true', 'false', 1, 0];

    for (const isActive of invalidValues) {
      const result = UpdateHoldingDto.safeParse({ isActive });
      expect(result.success).toBe(false);
    }
  });
});

// SC-1462 dropped the database CHECK that also refused a negative balance, so
// these validators are the only line between a person and a margin loan they
// typed themselves. Only a broker statement may report one.
describe('user-entered balances still refuse a negative (SC-1462)', () => {
  const margin = '-5509.33';
  const ids = {
    accountId: '550e8400-e29b-41d4-a716-446655440000',
    tokenId: '550e8400-e29b-41d4-a716-446655440001',
  };

  // An edit may carry a negative since SC-1640: what a loan or card owes.
  // `UpdateHoldingUseCase` refuses it on any other holding, which is where
  // the account's class is known (UpdateHoldingUseCase.owed.test.ts).
  test('edit carries the sign to the use case', () => {
    expect(UpdateHoldingDto.safeParse({ balance: margin }).success).toBe(true);
  });

  test('batch add', () => {
    const r = CreateHoldingsWithDependenciesDto.safeParse({
      accountId: ids.accountId,
      holdings: [{ tokenId: ids.tokenId, balance: margin }],
    });
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => i.path.join('.'))).toEqual(['holdings.0.balance']);
  });

  // The control: the same payload at zero passes, so the refusals above are
  // about the sign and nothing else.
  test('the same payloads at zero pass', () => {
    expect(UpdateHoldingDto.safeParse({ balance: '0' }).success).toBe(true);
    expect(
      CreateHoldingsWithDependenciesDto.safeParse({
        accountId: ids.accountId,
        holdings: [{ tokenId: ids.tokenId, balance: '0' }],
      }).success
    ).toBe(true);
  });
});
