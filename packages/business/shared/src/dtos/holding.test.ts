import { describe, expect, test } from 'bun:test';
import { CreateHoldingDto, UpdateHoldingDto } from './holding';

describe('CreateHoldingDto validation', () => {
  test('should accept valid holding data', () => {
    const validData = {
      accountId: '550e8400-e29b-41d4-a716-446655440000',
      tokenId: '550e8400-e29b-41d4-a716-446655440001',
      balance: '123.45',
    };

    const result = CreateHoldingDto.safeParse(validData);
    expect(result.success).toBe(true);
  });

  test('should accept valid holding with various balance formats', () => {
    const validBalances = ['0', '1.0', '123.456', '0.001', '1000000'];

    for (const balance of validBalances) {
      const data = {
        accountId: '550e8400-e29b-41d4-a716-446655440000',
        tokenId: '550e8400-e29b-41d4-a716-446655440001',
        balance,
      };

      const result = CreateHoldingDto.safeParse(data);
      expect(result.success).toBe(true);
    }
  });

  test('should reject invalid balance values', () => {
    const invalidBalances = [
      'abc', // Not a number
      'NaN', // Special value
      'Infinity', // Special value
      '-Infinity', // Special value
      '12.34.56', // Multiple decimal points
      '1,000', // Comma separator
      '123abc', // Trailing letters
      '', // Empty string
      '  ', // Whitespace only
    ];

    for (const balance of invalidBalances) {
      const data = {
        accountId: '550e8400-e29b-41d4-a716-446655440000',
        tokenId: '550e8400-e29b-41d4-a716-446655440001',
        balance,
      };

      const result = CreateHoldingDto.safeParse(data);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.path).toContain('balance');
      }
    }
  });

  test('should reject negative balance', () => {
    const data = {
      accountId: '550e8400-e29b-41d4-a716-446655440000',
      tokenId: '550e8400-e29b-41d4-a716-446655440001',
      balance: '-5',
    };

    const result = CreateHoldingDto.safeParse(data);
    expect(result.success).toBe(false);
  });
});

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
    const invalidBalances = ['abc', 'NaN', 'Infinity', '-5', '12.34.56', ''];

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
