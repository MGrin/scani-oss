import { describe, expect, test } from 'bun:test';
import { CurrentUserDto, UpdateUserDto } from '../../src/dtos/user';

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

describe('CurrentUserDto', () => {
  /**
   * A whole `users` row as the three handlers used to return it. Written out
   * rather than derived from `@scani/db`, which this package may not import —
   * so it will drift from the table, and that is fine: the claim under test is
   * about what the SCHEMA lets through, and a column this literal has never
   * heard of is exactly the case the schema is supposed to stop.
   */
  const WHOLE_ROW = {
    id: VALID_UUID,
    email: 'reader@example.com',
    emailVerified: true,
    name: 'Reader',
    avatar: null,
    image: null,
    timezone: 'Asia/Makassar',
    baseCurrencyId: null,
    costBasisMethod: 'fifo',
    firstExportAt: null,
    emailUnsubscribeToken: '11111111-1111-4111-8111-111111111111',
    digestOptOutAt: null,
    alertsOptOutAt: null,
    digestLastSentAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  test('the fixture carries the credential — without this the next test passes vacuously', () => {
    expect(WHOLE_ROW).toHaveProperty('emailUnsubscribeToken');
  });

  test('parsing a whole row keeps exactly the named fields and nothing else', () => {
    expect(Object.keys(CurrentUserDto.parse(WHOLE_ROW)).sort()).toEqual([
      'baseCurrencyId',
      'email',
      'id',
      'name',
      'timezone',
    ]);
  });

  /**
   * The one this file exists for (SC-688). `emailUnsubscribeToken` is the
   * bearer credential every unsubscribe link authenticates on, and it reached
   * every signed-in tab for as long as these handlers returned a row instead
   * of a shape. Asserted by name and separately from the key-set test above,
   * so that a future edit widening the schema fails on the sentence that says
   * why rather than on a list nobody reads.
   */
  test('the unsubscribe token never survives the parse', () => {
    expect(CurrentUserDto.parse(WHOLE_ROW)).not.toHaveProperty('emailUnsubscribeToken');
  });
});
