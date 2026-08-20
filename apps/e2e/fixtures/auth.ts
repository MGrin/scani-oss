import type { APIResponse, Page, TestInfo } from '@playwright/test';
import { mailpit } from './mailpit';

const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:3011';

async function postAuth(
  page: Page,
  url: string,
  data: unknown,
  label: string,
  identity: string
): Promise<APIResponse> {
  const res = await page.request.post(url, {
    data,
    headers: {
      'content-type': 'application/json',
      origin: 'http://localhost:5173',
      // Each simulated user signs in from a client of its own. The api's
      // signup limiter counts `send-verification-otp` *and* `sign-in` against
      // one 6-per-hour budget per client IP, so without this a spec that signs
      // in three times would spend its whole budget on itself, and a spec that
      // signs in once would still be sharing with every sibling worker.
      //
      // This deliberately does NOT retry a 429. The suite used to, on its own
      // backoff, which turned "the isolation broke" into "the run was 8s
      // slower" — the failure this whole change exists to make visible
      // (SC-489).
      'x-real-ip': identity,
    },
  });
  if (!res.ok()) {
    throw new Error(`${label} failed: ${res.status()} ${await res.text()}`);
  }
  return res;
}

export interface SignedInContext {
  email: string;
  userId: string;
  page: Page;
}

/**
 * Sign in a brand-new user via the OTP flow. Each call generates a
 * unique email so concurrent tests don't collide. After this returns,
 * `page` is signed in and any subsequent navigation uses the session
 * cookie automatically (Playwright shares cookies within a context).
 *
 * The OTP path used here is the same one the SPA's AuthContext calls:
 *   POST /api/auth/email-otp/send-verification-otp { email, type:'sign-in' }
 *   poll Mailpit for the OTP
 *   POST /api/auth/sign-in/email-otp { email, otp }
 *
 * Side effect: a row appears in `users` and `user_sessions`. The user
 * is otherwise empty — tests build up whatever fixtures they need
 * through the real UI/API.
 */
export async function signIn({
  page,
  testInfo,
  label,
}: {
  page: Page;
  /** Supplied by specs; its `testId` keeps concurrent sign-ins distinct. */
  testInfo?: TestInfo;
  /** Discriminator for callers outside the test runner (e.g. `scripts/shots.ts`). */
  label?: string;
}): Promise<SignedInContext> {
  const discriminator = testInfo?.testId ?? label;
  if (!discriminator) throw new Error('signIn requires either `testInfo` or `label`');
  const email = `e2e-${discriminator}-${Date.now()}@example.com`;
  const identity = `e2e-auth-${email}`;

  await postAuth(
    page,
    `${API_BASE_URL}/api/auth/email-otp/send-verification-otp`,
    { email, type: 'sign-in' },
    'OTP request',
    identity
  );

  const message = await mailpit.waitForMessageTo(email);
  const otp = mailpit.extractOtpFromSubject(message.Subject);

  const signInRes = await postAuth(
    page,
    `${API_BASE_URL}/api/auth/sign-in/email-otp`,
    { email, otp },
    'OTP sign-in',
    identity
  );
  const signInBody = (await signInRes.json()) as { user?: { id?: string } };
  const userId = signInBody.user?.id;
  if (!userId) throw new Error(`Sign-in response missing user.id: ${JSON.stringify(signInBody)}`);

  return { email, userId, page };
}
