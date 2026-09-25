/**
 * Cloudflare Turnstile verification (SC-1266). A fixed-budget outbound call, so
 * it lives beside the other bounded fetches.
 *
 * Every unauthenticated request that makes Scani send an email carries a
 * Turnstile token, and the server asks Cloudflare whether it is genuine before
 * anything is sent. Inert until a secret is configured: with none, every
 * request passes unchecked, so this can ship before the widget keys exist.
 */

export const TURNSTILE_HEADER = 'x-turnstile-token';

// Every Better-Auth route that sends mail WITHOUT a session. Verifying a code
// (`/sign-in/email-otp`) sends nothing, and change-email needs a signed-in user.
const MAIL_SENDING_AUTH_PATHS = [
  '/api/auth/sign-in/magic-link',
  '/api/auth/sign-up',
  '/api/auth/email-otp/send-verification-otp',
  '/api/auth/email-otp/request-password-reset',
  '/api/auth/forget-password',
];

export function isTurnstileAuthPath(method: string, pathname: string): boolean {
  return method === 'POST' && MAIL_SENDING_AUTH_PATHS.some((p) => pathname.startsWith(p));
}

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const TIMEOUT_MS = 5_000;

export type TurnstileVerdict =
  | { ok: true; checked: boolean }
  | { ok: false; reason: 'missing-token' | 'rejected' | 'unavailable' };

export async function verifyTurnstile(opts: {
  secret: string | undefined;
  token: string | null | undefined;
  fetchImpl?: typeof fetch;
}): Promise<TurnstileVerdict> {
  if (!opts.secret) return { ok: true, checked: false };
  const token = opts.token?.trim();
  if (!token) return { ok: false, reason: 'missing-token' };

  // Fails CLOSED: letting a request through whenever Cloudflare cannot be
  // asked would reopen the mail flood at exactly the moment nobody is looking.
  try {
    const res = await (opts.fetchImpl ?? fetch)(VERIFY_URL, {
      method: 'POST',
      body: new URLSearchParams({ secret: opts.secret, response: token }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, reason: 'unavailable' };
    const body = (await res.json()) as { success?: unknown };
    return body.success === true ? { ok: true, checked: true } : { ok: false, reason: 'rejected' };
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
}

export const TURNSTILE_MESSAGES = {
  failed: 'The human check failed. Reload the page and try again.',
  unavailable: 'The human check could not be completed. Try again in a minute.',
} as const;

export interface TurnstileRefusal {
  status: 403 | 503;
  message: string;
}

/**
 * The whole check for one incoming request: `null` when it may proceed (a
 * path that sends no mail, no secret configured, or a genuine token).
 */
export async function turnstileRefusal(
  request: Request,
  secret: string | undefined,
  fetchImpl?: typeof fetch
): Promise<TurnstileRefusal | null> {
  if (!isTurnstileAuthPath(request.method, new URL(request.url).pathname)) return null;
  const verdict = await verifyTurnstile({
    secret,
    token: request.headers.get(TURNSTILE_HEADER),
    fetchImpl,
  });
  if (verdict.ok) return null;
  return verdict.reason === 'unavailable'
    ? { status: 503, message: TURNSTILE_MESSAGES.unavailable }
    : { status: 403, message: TURNSTILE_MESSAGES.failed };
}
