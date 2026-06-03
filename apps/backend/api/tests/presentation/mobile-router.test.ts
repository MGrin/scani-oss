import { describe, expect, it } from 'bun:test';
import {
  MobileAccount,
  MobileGroup,
  MobileHolding,
  MobileToken,
  MobileVault,
} from '../../src/presentation/mobile-dtos';
import { mobileRouter } from '../../src/presentation/routers/mobile';

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

describe('MobileToken DTO', () => {
  it('parses valid token', () => {
    expect(MobileToken.safeParse({ id: 'uuid-1', symbol: 'USD', name: 'US Dollar' }).success).toBe(
      true
    );
  });

  it('rejects missing name', () => {
    expect(MobileToken.safeParse({ id: 'uuid-1', symbol: 'USD' }).success).toBe(false);
  });
});

describe('mobileRouter read endpoints', () => {
  it('exposes currencies query', () => {
    expect(mobileRouter._def.procedures.currencies).toBeDefined();
  });

  it('exposes searchTokens query', () => {
    expect(mobileRouter._def.procedures.searchTokens).toBeDefined();
  });

  it('searchTokens input: query must be 1-100 chars', () => {
    const schema = mobileRouter._def.procedures.searchTokens._def.inputs[0];
    expect(schema.safeParse({ query: '' }).success).toBe(false);
    expect(schema.safeParse({ query: 'BTC' }).success).toBe(true);
    expect(schema.safeParse({ query: 'a'.repeat(101) }).success).toBe(false);
    expect(schema.safeParse({ query: 'a'.repeat(100) }).success).toBe(true);
  });
});

describe('mobileRouter mutation keys', () => {
  it('exposes updateAccount mutation', () => {
    expect(mobileRouter._def.procedures.updateAccount).toBeDefined();
  });

  it('exposes deleteAccount mutation', () => {
    expect(mobileRouter._def.procedures.deleteAccount).toBeDefined();
  });

  it('exposes createHolding mutation', () => {
    expect(mobileRouter._def.procedures.createHolding).toBeDefined();
  });

  it('exposes updateHolding mutation', () => {
    expect(mobileRouter._def.procedures.updateHolding).toBeDefined();
  });

  it('exposes deleteHolding mutation', () => {
    expect(mobileRouter._def.procedures.deleteHolding).toBeDefined();
  });

  it('exposes createGroup mutation', () => {
    expect(mobileRouter._def.procedures.createGroup).toBeDefined();
  });

  it('exposes updateGroup mutation', () => {
    expect(mobileRouter._def.procedures.updateGroup).toBeDefined();
  });

  it('exposes deleteGroup mutation', () => {
    expect(mobileRouter._def.procedures.deleteGroup).toBeDefined();
  });

  it('exposes createVault mutation', () => {
    expect(mobileRouter._def.procedures.createVault).toBeDefined();
  });

  it('exposes updateVault mutation', () => {
    expect(mobileRouter._def.procedures.updateVault).toBeDefined();
  });

  it('exposes deleteVault mutation', () => {
    expect(mobileRouter._def.procedures.deleteVault).toBeDefined();
  });
});

describe('mobile mutation input DTOs', () => {
  it('updateAccount input: id must be uuid', () => {
    const schema = mobileRouter._def.procedures.updateAccount._def.inputs[0];
    expect(schema.safeParse({ id: 'not-a-uuid', data: {} }).success).toBe(false);
    expect(
      schema.safeParse({
        id: '123e4567-e89b-12d3-a456-426614174000',
        data: { name: 'New Name' },
      }).success
    ).toBe(true);
  });

  it('deleteAccount input: id must be uuid', () => {
    const schema = mobileRouter._def.procedures.deleteAccount._def.inputs[0];
    expect(schema.safeParse({ id: 'bad' }).success).toBe(false);
    expect(schema.safeParse({ id: '123e4567-e89b-12d3-a456-426614174000' }).success).toBe(true);
  });

  it('createHolding input: data.accountId and data.tokenId must be uuids', () => {
    const schema = mobileRouter._def.procedures.createHolding._def.inputs[0];
    expect(
      schema.safeParse({
        data: {
          accountId: 'bad',
          tokenId: 'bad',
          balance: '1.0',
        },
      }).success
    ).toBe(false);
    expect(
      schema.safeParse({
        data: {
          accountId: '123e4567-e89b-12d3-a456-426614174000',
          tokenId: '123e4567-e89b-12d3-a456-426614174001',
          balance: '1.5',
        },
      }).success
    ).toBe(true);
  });

  it('updateHolding input: id must be uuid', () => {
    const schema = mobileRouter._def.procedures.updateHolding._def.inputs[0];
    expect(schema.safeParse({ id: 'bad', data: {} }).success).toBe(false);
    expect(
      schema.safeParse({
        id: '123e4567-e89b-12d3-a456-426614174000',
        data: { balance: '2.5' },
      }).success
    ).toBe(true);
  });

  it('deleteHolding input: id must be uuid', () => {
    const schema = mobileRouter._def.procedures.deleteHolding._def.inputs[0];
    expect(schema.safeParse({ id: 'bad' }).success).toBe(false);
    expect(schema.safeParse({ id: '123e4567-e89b-12d3-a456-426614174000' }).success).toBe(true);
  });

  it('createGroup input: name + color required, description optional', () => {
    const schema = mobileRouter._def.procedures.createGroup._def.inputs[0];
    expect(schema.safeParse({ name: '', color: '#ff0000' }).success).toBe(false);
    expect(schema.safeParse({ name: 'My Group', color: 'not-a-hex' }).success).toBe(false);
    expect(schema.safeParse({ name: 'My Group', color: '#ff0000' }).success).toBe(true);
    expect(
      schema.safeParse({ name: 'My Group', color: '#ff0000', description: 'desc' }).success
    ).toBe(true);
  });

  it('updateGroup input: id must be uuid', () => {
    const schema = mobileRouter._def.procedures.updateGroup._def.inputs[0];
    expect(schema.safeParse({ id: 'bad', data: {} }).success).toBe(false);
    expect(
      schema.safeParse({ id: '123e4567-e89b-12d3-a456-426614174000', data: { name: 'New' } })
        .success
    ).toBe(true);
  });

  it('deleteGroup input: id must be uuid', () => {
    const schema = mobileRouter._def.procedures.deleteGroup._def.inputs[0];
    expect(schema.safeParse({ id: 'bad' }).success).toBe(false);
    expect(schema.safeParse({ id: '123e4567-e89b-12d3-a456-426614174000' }).success).toBe(true);
  });

  it('createVault input: required fields validated', () => {
    const schema = mobileRouter._def.procedures.createVault._def.inputs[0];
    expect(
      schema.safeParse({
        name: '',
        targetAmount: '100',
        currencyId: '123e4567-e89b-12d3-a456-426614174000',
        color: '#ff0000',
      }).success
    ).toBe(false);
    expect(
      schema.safeParse({
        name: 'Emergency Fund',
        targetAmount: '10000',
        currencyId: '123e4567-e89b-12d3-a456-426614174000',
        color: '#ff0000',
      }).success
    ).toBe(true);
  });

  it('updateVault input: id must be uuid', () => {
    const schema = mobileRouter._def.procedures.updateVault._def.inputs[0];
    expect(schema.safeParse({ id: 'bad', data: {} }).success).toBe(false);
    expect(
      schema.safeParse({ id: '123e4567-e89b-12d3-a456-426614174000', data: { name: 'Updated' } })
        .success
    ).toBe(true);
  });

  it('deleteVault input: id must be uuid', () => {
    const schema = mobileRouter._def.procedures.deleteVault._def.inputs[0];
    expect(schema.safeParse({ id: 'bad' }).success).toBe(false);
    expect(schema.safeParse({ id: '123e4567-e89b-12d3-a456-426614174000' }).success).toBe(true);
  });
});

describe('mobile group/vault DTOs', () => {
  it('MobileGroup parses valid object', () => {
    expect(
      MobileGroup.safeParse({
        id: 'g1',
        name: 'Crypto',
        color: '#3b82f6',
        description: null,
      }).success
    ).toBe(true);
  });

  it('MobileGroup accepts non-null description', () => {
    expect(
      MobileGroup.safeParse({
        id: 'g1',
        name: 'Crypto',
        color: '#3b82f6',
        description: 'My crypto holdings',
      }).success
    ).toBe(true);
  });

  it('MobileGroup rejects missing field', () => {
    expect(MobileGroup.safeParse({ id: 'g1', name: 'Crypto' }).success).toBe(false);
  });

  it('MobileVault parses valid object', () => {
    expect(
      MobileVault.safeParse({
        id: 'v1',
        name: 'Emergency Fund',
        targetAmount: '10000',
        currentAmount: '0',
        currencyId: '123e4567-e89b-12d3-a456-426614174000',
        color: '#22c55e',
        iconName: null,
        description: null,
      }).success
    ).toBe(true);
  });

  it('MobileVault rejects missing currencyId', () => {
    expect(
      MobileVault.safeParse({
        id: 'v1',
        name: 'Emergency Fund',
        targetAmount: '10000',
        currentAmount: '0',
        color: '#22c55e',
        iconName: null,
        description: null,
      }).success
    ).toBe(false);
  });
});
