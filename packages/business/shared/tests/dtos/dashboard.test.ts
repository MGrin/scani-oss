import { describe, expect, test } from 'bun:test';
import {
  AssetAllocationDimensionDto,
  AssetAllocationItemDto,
  GetAssetAllocationInputDto,
  GetAssetAllocationOutputDto,
} from '../../src/dtos/dashboard';

describe('AssetAllocationDimensionDto', () => {
  test('accepts every supported dimension', () => {
    const dims = [
      'token',
      'token_type',
      'account',
      'account_type',
      'institution',
      'institution_type',
      'group',
    ];
    for (const d of dims) {
      expect(AssetAllocationDimensionDto.safeParse(d).success).toBe(true);
    }
  });

  test('rejects unknown dimensions (locks the wire contract)', () => {
    expect(AssetAllocationDimensionDto.safeParse('country').success).toBe(false);
    expect(AssetAllocationDimensionDto.safeParse('').success).toBe(false);
  });
});

describe('GetAssetAllocationInputDto', () => {
  test('accepts a valid dimension', () => {
    expect(GetAssetAllocationInputDto.safeParse({ dimension: 'token' }).success).toBe(true);
  });

  test('rejects a missing dimension', () => {
    expect(GetAssetAllocationInputDto.safeParse({}).success).toBe(false);
  });
});

describe('AssetAllocationItemDto', () => {
  test('accepts a well-formed item', () => {
    expect(
      AssetAllocationItemDto.safeParse({
        id: 'token-1',
        code: 'BTC',
        name: 'Bitcoin',
        value: '12345.67',
        percentage: '42.5',
      }).success
    ).toBe(true);
  });

  test('rejects when value is a number (must be string for Decimal precision)', () => {
    expect(
      AssetAllocationItemDto.safeParse({
        id: 'x',
        code: 'x',
        name: 'x',
        value: 12345,
        percentage: '0',
      }).success
    ).toBe(false);
  });
});

describe('GetAssetAllocationOutputDto', () => {
  test('accepts a complete output payload', () => {
    expect(
      GetAssetAllocationOutputDto.safeParse({
        dimension: 'token_type',
        items: [
          { id: '1', code: 'crypto', name: 'Crypto', value: '100', percentage: '50' },
          { id: '2', code: 'fiat', name: 'Fiat', value: '100', percentage: '50' },
        ],
        totalDebt: '0',
        liabilityDebt: '0',
        totalValue: '200',
        baseCurrency: 'USD',
      }).success
    ).toBe(true);
  });

  test('accepts an empty items array', () => {
    expect(
      GetAssetAllocationOutputDto.safeParse({
        dimension: 'group',
        items: [],
        totalDebt: '0',
        liabilityDebt: '0',
        totalValue: '0',
        baseCurrency: 'USD',
      }).success
    ).toBe(true);
  });

  test('rejects items that fail item-shape validation', () => {
    expect(
      GetAssetAllocationOutputDto.safeParse({
        dimension: 'token',
        items: [{ id: 'x' /* missing other fields */ }],
        totalDebt: '0',
        liabilityDebt: '0',
        totalValue: '0',
        baseCurrency: 'USD',
      }).success
    ).toBe(false);
  });

  test('carries total debt beside the slices, and requires it', () => {
    const payload = {
      dimension: 'token_type',
      items: [{ id: '1', code: 'stock', name: 'Stock', value: '10000', percentage: '100.00' }],
      totalDebt: '-2500',
      liabilityDebt: '0',
      totalValue: '7500',
      baseCurrency: 'USD',
    };
    expect(GetAssetAllocationOutputDto.safeParse(payload).success).toBe(true);
    const { totalDebt: _omitted, ...withoutDebt } = payload;
    expect(GetAssetAllocationOutputDto.safeParse(withoutDebt).success).toBe(false);
    // SC-1640: the loan and card part of that debt is required beside it.
    const { liabilityDebt: _omittedLoans, ...withoutLoans } = payload;
    expect(GetAssetAllocationOutputDto.safeParse(withoutLoans).success).toBe(false);
  });
});
