import { describe, expect, test } from 'bun:test';
import { isBlockedAuthPath } from '../src/blocked-auth-paths';

// SC-1351: Better-Auth mounts routes we never use. Passwords are off, yet the
// email-otp plugin's reset routes still emailed a code and could create a
// credential account; `check-verification-otp` answered USER_NOT_FOUND for an
// unknown address. Nothing of ours calls any of them.

describe('isBlockedAuthPath (SC-1351)', () => {
  test.each([
    '/api/auth/email-otp/check-verification-otp',
    '/api/auth/email-otp/request-password-reset',
    '/api/auth/email-otp/reset-password',
    '/api/auth/forget-password',
    '/api/auth/forget-password/email-otp',
    '/api/auth/request-password-reset',
    '/api/auth/reset-password',
    '/api/auth/reset-password/some-token',
    '/api/auth/change-password',
    '/api/auth/set-password',
    '/api/auth/verify-password',
    '/api/auth/sign-in/email',
    '/api/auth/sign-up/email',
  ])('refuses %s', (path) => {
    expect(isBlockedAuthPath(path)).toBe(true);
  });

  // The routes the app and the cloud console call: AuthContext.tsx and the
  // cloud AuthPage. Blocking any of these would lock everybody out.
  test.each([
    '/api/auth/get-session',
    '/api/auth/sign-out',
    '/api/auth/sign-in/magic-link',
    '/api/auth/sign-in/email-otp',
    '/api/auth/email-otp/send-verification-otp',
    '/api/auth/magic-link/verify',
    '/api/auth/list-sessions',
    '/api/auth/revoke-session',
    '/api/auth/sign-in/email-otpx',
  ])('control: lets %s through', (path) => {
    expect(isBlockedAuthPath(path)).toBe(false);
  });

  test('matches whole segments, not prefixes of a word', () => {
    expect(isBlockedAuthPath('/api/auth/sign-in/emailing')).toBe(false);
    expect(isBlockedAuthPath('/api/auth/change-password-please')).toBe(false);
  });
});
