import { describe, expect, test } from 'bun:test';
import { CreateHoldingsWithDependenciesDto } from './batch';

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
