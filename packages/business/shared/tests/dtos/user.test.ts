import { describe, expect, test } from 'bun:test';
import { UpdateUserDto } from '../../src/dtos/user';

const VALID_UUID = '00000000-0000-4000-8000-000000000000';

describe('UpdateUserDto', () => {
  test('accepts an empty patch (all fields optional)', () => {
    expect(UpdateUserDto.safeParse({}).success).toBe(true);
  });

  test('accepts a name change only', () => {
    expect(UpdateUserDto.safeParse({ name: 'Alice' }).success).toBe(true);
  });

  test('accepts a baseCurrencyId change only', () => {
    expect(UpdateUserDto.safeParse({ baseCurrencyId: VALID_UUID }).success).toBe(true);
  });

  test('avatar accepts null (explicit clear)', () => {
    expect(UpdateUserDto.safeParse({ avatar: null }).success).toBe(true);
  });

  test('baseCurrencyId accepts null (explicit clear)', () => {
    expect(UpdateUserDto.safeParse({ baseCurrencyId: null }).success).toBe(true);
  });

  test('rejects empty name', () => {
    expect(UpdateUserDto.safeParse({ name: '' }).success).toBe(false);
  });

  test('rejects non-URL avatar', () => {
    expect(UpdateUserDto.safeParse({ avatar: 'not-a-url' }).success).toBe(false);
  });

  test('rejects non-uuid baseCurrencyId', () => {
    expect(UpdateUserDto.safeParse({ baseCurrencyId: 'not-a-uuid' }).success).toBe(false);
  });
});
