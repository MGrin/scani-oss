import { describe, expect, test } from 'bun:test';
import { createNewAddressCap } from '../../src/auth/new-address-cap';

const OTP = '/api/auth/email-otp/send-verification-otp';
const LINK = '/api/auth/sign-in/magic-link';

function cap(perHour: number, existing: string[] = []) {
  const known = new Set(existing);
  return createNewAddressCap({ redis: null, perHour, hasAccount: async (e) => known.has(e) });
}

describe('new-address send cap (SC-1260)', () => {
  test('new addresses stop at the cap and get the success body, not a 429', async () => {
    const gate = cap(2);
    expect(await gate('POST', OTP, { email: 'a@example.com' })).toEqual({ send: true });
    expect(await gate('POST', LINK, { email: 'b@example.com' })).toEqual({ send: true });
    expect(await gate('POST', OTP, { email: 'c@example.com' })).toEqual({
      send: false,
      body: { success: true },
    });
    expect(await gate('POST', LINK, { email: 'd@example.com' })).toEqual({
      send: false,
      body: { status: true },
    });
  });

  test('an address with an account is never counted and never refused', async () => {
    const gate = cap(1, ['old@example.com']);
    for (let i = 0; i < 5; i++) {
      expect(await gate('POST', OTP, { email: 'OLD@example.com ' })).toEqual({ send: true });
    }
    expect(await gate('POST', OTP, { email: 'new@example.com' })).toEqual({ send: true });
    expect((await gate('POST', OTP, { email: 'new2@example.com' })).send).toBe(false);
    expect(await gate('POST', OTP, { email: 'old@example.com' })).toEqual({ send: true });
  });

  test('other routes and bodies without an email pass through uncounted', async () => {
    const gate = cap(1);
    for (let i = 0; i < 3; i++) {
      expect(await gate('POST', '/api/auth/sign-in/email-otp', { email: 'x@e.com' })).toEqual({
        send: true,
      });
      expect(await gate('GET', OTP, { email: 'x@e.com' })).toEqual({ send: true });
      expect(await gate('POST', OTP, {})).toEqual({ send: true });
    }
    expect(await gate('POST', OTP, { email: 'first@example.com' })).toEqual({ send: true });
  });
});
