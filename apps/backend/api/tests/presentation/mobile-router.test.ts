import { describe, expect, it } from 'bun:test';
import { MobileAccount, MobileHolding } from '../../src/presentation/mobile-dtos';
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
});
