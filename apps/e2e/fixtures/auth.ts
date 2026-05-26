import type { Page, TestInfo } from '@playwright/test';
import { mailpit } from './mailpit';

const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:3011';

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

  const sendRes = await page.request.post(
    `${API_BASE_URL}/api/auth/email-otp/send-verification-otp`,
    {
      data: { email, type: 'sign-in' },
      headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
    }
  );
  if (!sendRes.ok()) {
    throw new Error(`OTP request failed: ${sendRes.status()} ${await sendRes.text()}`);
  }

  const message = await mailpit.waitForMessageTo(email);
  const otp = mailpit.extractOtpFromSubject(message.Subject);

  const signInRes = await page.request.post(`${API_BASE_URL}/api/auth/sign-in/email-otp`, {
    data: { email, otp },
    headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
  });
  if (!signInRes.ok()) {
    throw new Error(`OTP sign-in failed: ${signInRes.status()} ${await signInRes.text()}`);
  }
  const signInBody = (await signInRes.json()) as { user?: { id?: string } };
  const userId = signInBody.user?.id;
  if (!userId) throw new Error(`Sign-in response missing user.id: ${JSON.stringify(signInBody)}`);

  return { email, userId, page };
}
