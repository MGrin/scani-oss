import { describe, expect, it } from 'bun:test';
import { MobileAccount, MobileHolding } from '../../src/presentation/mobile-dtos';

describe('mobile DTOs', () => {
  it('MobileAccount parses valid object', () => {
    expect(
      MobileAccount.safeParse({
        id: 'a',
        name: 'Checking',
        typeId: 'type-uuid',
        institutionId: null,
        totalValue: '1000.00',
      }).success
    ).toBe(true);
  });

  it('MobileAccount rejects missing field', () => {
    expect(MobileAccount.safeParse({ id: 'a' }).success).toBe(false);
  });

  it('MobileAccount accepts non-null institutionId', () => {
    expect(
      MobileAccount.safeParse({
        id: 'a',
        name: 'Brokerage',
        typeId: 'type-uuid',
        institutionId: 'inst-uuid',
        totalValue: '5000.00',
      }).success
    ).toBe(true);
  });

  it('MobileHolding parses valid object with non-null value', () => {
    expect(
      MobileHolding.safeParse({
        id: 'h',
        accountId: 'a',
        symbol: 'BTC',
        name: 'Bitcoin',
        amount: '1',
        value: '100000.00',
      }).success
    ).toBe(true);
  });

  it('MobileHolding parses with null value (unpriced holding)', () => {
    expect(
      MobileHolding.safeParse({
        id: 'h',
        accountId: 'a',
        symbol: 'UNKNOWN',
        name: 'Unknown Token',
        amount: '42',
        value: null,
      }).success
    ).toBe(true);
  });
});
