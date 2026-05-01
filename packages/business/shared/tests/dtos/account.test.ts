import { describe, expect, test } from 'bun:test';
import { CreateAccountDto, UpdateAccountDto } from '../../src/dtos/account';

const VALID_UUID = '00000000-0000-4000-8000-000000000000';

describe('CreateAccountDto', () => {
  test('accepts a minimal valid payload', () => {
    expect(CreateAccountDto.safeParse({ name: 'Checking', typeId: VALID_UUID }).success).toBe(true);
  });

  test('accepts all optional fields', () => {
    const result = CreateAccountDto.safeParse({
      institutionId: VALID_UUID,
      name: 'Savings',
      typeId: VALID_UUID,
      description: 'Rainy-day fund',
      metadata: { walletAddress: '0xabc' },
    });
    expect(result.success).toBe(true);
  });

  test('rejects empty name', () => {
    expect(CreateAccountDto.safeParse({ name: '', typeId: VALID_UUID }).success).toBe(false);
  });

  test('rejects name over 100 chars', () => {
    expect(CreateAccountDto.safeParse({ name: 'a'.repeat(101), typeId: VALID_UUID }).success).toBe(
      false
    );
  });

  test('rejects non-uuid typeId', () => {
    expect(CreateAccountDto.safeParse({ name: 'x', typeId: 'not-a-uuid' }).success).toBe(false);
  });

  test('rejects non-uuid institutionId when present', () => {
    expect(
      CreateAccountDto.safeParse({ name: 'x', typeId: VALID_UUID, institutionId: 'bogus' }).success
    ).toBe(false);
  });

  test('rejects description over 500 chars', () => {
    expect(
      CreateAccountDto.safeParse({
        name: 'x',
        typeId: VALID_UUID,
        description: 'a'.repeat(501),
      }).success
    ).toBe(false);
  });
});

describe('UpdateAccountDto', () => {
  test('accepts an empty patch (all fields optional)', () => {
    expect(UpdateAccountDto.safeParse({}).success).toBe(true);
  });

  test('accepts a partial patch', () => {
    expect(UpdateAccountDto.safeParse({ name: 'Renamed' }).success).toBe(true);
  });

  test('description allows null (explicit clear)', () => {
    expect(UpdateAccountDto.safeParse({ description: null }).success).toBe(true);
  });

  test('rejects empty name when present', () => {
    expect(UpdateAccountDto.safeParse({ name: '' }).success).toBe(false);
  });

  test('rejects non-uuid typeId when present', () => {
    expect(UpdateAccountDto.safeParse({ typeId: 'not-a-uuid' }).success).toBe(false);
  });
});
