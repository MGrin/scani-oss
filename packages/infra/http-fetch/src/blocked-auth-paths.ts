/**
 * Better-Auth routes Scani never uses, answered 404 before Better-Auth sees
 * them (SC-1351). Both the api and the data-provider check this.
 *
 * Passwords are off (`emailAndPassword.enabled: false`), but that only stops
 * core sign-in and sign-up. The email-otp plugin's reset routes ignore it:
 * `/email-otp/request-password-reset` emailed a code to any registered address
 * and `/email-otp/reset-password` created a credential account.
 * `/email-otp/check-verification-otp` answered USER_NOT_FOUND for an unknown
 * address. The frontends call none of these; they use get-session, sign-out,
 * send-verification-otp and the magic-link and email-otp sign-ins.
 */
const BLOCKED = [
  '/api/auth/email-otp/check-verification-otp',
  '/api/auth/email-otp/request-password-reset',
  '/api/auth/email-otp/reset-password',
  '/api/auth/forget-password',
  '/api/auth/request-password-reset',
  '/api/auth/reset-password',
  '/api/auth/change-password',
  '/api/auth/set-password',
  '/api/auth/verify-password',
  '/api/auth/sign-in/email',
  '/api/auth/sign-up/email',
];

export function isBlockedAuthPath(pathname: string): boolean {
  return BLOCKED.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}
