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
    });
    expect(result.success).toBe(true);
  });

  test('carries no client metadata: a planted userWalletId never reaches the server (SC-1341)', () => {
    const result = CreateAccountDto.safeParse({
      name: 'Savings',
      typeId: VALID_UUID,
      metadata: { userWalletId: VALID_UUID },
    });
    expect(result.success).toBe(true);
    expect(result.success && 'metadata' in result.data).toBe(false);
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

describe('account wrapper (SC-1645)', () => {
  test('create and update keep a wrapper code, null, or none', () => {
    // `.parse`, not `.success`: zod strips an unknown key and still succeeds,
    // so a DTO without the field would pass a success-only check.
    for (const wrapper of ['isa', null, undefined]) {
      expect(CreateAccountDto.parse({ name: 'ISA', typeId: VALID_UUID, wrapper }).wrapper).toBe(
        wrapper
      );
      expect(UpdateAccountDto.parse({ wrapper }).wrapper).toBe(wrapper);
    }
  });

  test('a code longer than 40 characters is refused', () => {
    expect(UpdateAccountDto.safeParse({ wrapper: 'x'.repeat(41) }).success).toBe(false);
  });
});
