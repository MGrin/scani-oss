import type { APIResponse, Page, TestInfo } from '@playwright/test';
import { mailpit } from './mailpit';

const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:3011';

// The API guards its auth endpoints with a per-IP rate limiter. Under
// the E2E suite's parallel workers, bursts of OTP sign-ins briefly trip
// it (HTTP 429) even though the run as a whole is well under any sane
// budget. The 429 body advertises a full-window `retryAfterSec` (tens of
// minutes) that's far too long to honour in a test — but the burst
// itself clears within seconds, so we retry on our own short backoff.
const MAX_AUTH_ATTEMPTS = 6;

async function postAuthWithRetry(
  page: Page,
  url: string,
  data: unknown,
  label: string
): Promise<APIResponse> {
  let lastStatus = 0;
  let lastBody = '';
  for (let attempt = 0; attempt < MAX_AUTH_ATTEMPTS; attempt++) {
    const res = await page.request.post(url, {
      data,
      headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
    });
    if (res.ok()) return res;
    lastStatus = res.status();
    lastBody = await res.text();
    // Only the per-IP auth limiter is worth retrying; anything else is a
    // real failure we should surface immediately.
    if (lastStatus !== 429) break;
    await page.waitForTimeout(Math.min(1000 * 2 ** attempt, 8000));
  }
  throw new Error(`${label} failed: ${lastStatus} ${lastBody}`);
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
}: {
  page: Page;
  testInfo: TestInfo;
}): Promise<SignedInContext> {
  const email = `e2e-${testInfo.testId}-${Date.now()}@example.com`;

  await postAuthWithRetry(
    page,
    `${API_BASE_URL}/api/auth/email-otp/send-verification-otp`,
    { email, type: 'sign-in' },
    'OTP request'
  );

  const message = await mailpit.waitForMessageTo(email);
  const otp = mailpit.extractOtpFromSubject(message.Subject);

  const signInRes = await postAuthWithRetry(
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
