import type { APIResponse, Page, TestInfo } from '@playwright/test';
import { mailpit } from './mailpit';

const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:3011';

// The api counts `send-verification-otp` and `sign-in` against one
// 6-per-hour budget per client, and each test is its own client since SC-489
// (see `fixtures/test.ts`) — so one sign-in spends 2 of a budget nobody else
// can touch.
//
// This deliberately does NOT retry a 429, which the suite used to do on its own
// backoff. That turned "the isolation broke" into "the run was 8s slower",
// which is the failure the isolation exists to make visible.
async function postAuth(
  page: Page,
  url: string,
  data: unknown,
  label: string
): Promise<APIResponse> {
  const res = await page.request.post(url, {
    data,
    headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
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

  await postAuth(
    page,
    `${API_BASE_URL}/api/auth/email-otp/send-verification-otp`,
    { email, type: 'sign-in' },
    'OTP request'
  );

  const message = await mailpit.waitForMessageTo(email);
  const otp = mailpit.extractOtpFromSubject(message.Subject);

  const signInRes = await postAuth(
    page,
    `${API_BASE_URL}/api/auth/sign-in/email-otp`,
    { email, otp },
    'OTP sign-in'
  );
  const signInBody = (await signInRes.json()) as { user?: { id?: string } };
  const userId = signInBody.user?.id;
  if (!userId) throw new Error(`Sign-in response missing user.id: ${JSON.stringify(signInBody)}`);

  return { email, userId, page };
}
