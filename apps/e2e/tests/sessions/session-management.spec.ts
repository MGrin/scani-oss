import { expect, test } from '@playwright/test';
import { signIn } from '../../fixtures/auth';
import { mailpit } from '../../fixtures/mailpit';
import { resetAuthRateLimit } from '../../fixtures/redis';

const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:3011';

test.describe('sessions: list + revoke', () => {
  test.beforeEach(async () => {
    await resetAuthRateLimit();
  });

  test('user can list two sessions and revoke one from another context', async ({
    browser,
  }, testInfo) => {
    // Context A: sign in as user X
    const contextA = await browser.newContext();
    const pageA = await contextA.newPage();
    const { email } = await signIn({ page: pageA, testInfo });

    // Context B: sign in as SAME user X (fresh browser context = fresh cookies)
    const contextB = await browser.newContext();
    const pageB = await contextB.newPage();
    const sendRes = await pageB.request.post(
      `${API_BASE_URL}/api/auth/email-otp/send-verification-otp`,
      {
        data: { email, type: 'sign-in' },
        headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
      }
    );
    expect(sendRes.ok()).toBe(true);
    const msg = await mailpit.waitForMessageTo(email);
    const otp = mailpit.extractOtpFromSubject(msg.Subject);
    const signInB = await pageB.request.post(`${API_BASE_URL}/api/auth/sign-in/email-otp`, {
      data: { email, otp },
      headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
    });
    expect(signInB.ok()).toBe(true);

    // Both sessions should show in A's session list (tRPC query)
    const listRes = await pageA.request.get(`${API_BASE_URL}/trpc/sessions.list?input=%7B%7D`);
    expect(listRes.ok()).toBe(true);
    const listBody = (await listRes.json()) as {
      result: { data: { token: string; isCurrent: boolean }[] };
    };
    expect(listBody.result.data.length).toBe(2);
    const otherToken = listBody.result.data.find((s) => !s.isCurrent)?.token;
    expect(otherToken).toBeTruthy();

    // Revoke B from A
    const revokeRes = await pageA.request.post(`${API_BASE_URL}/trpc/sessions.revoke`, {
      data: { token: otherToken },
      headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
    });
    expect(revokeRes.ok()).toBe(true);

    // B's next get-session should be unauthenticated. In dev the API has
    // Better-Auth's per-process cookie cache enabled (5 min) so we have
    // to disable it on this call — otherwise B's cookie still resolves
    // from the in-memory cache even though the DB session row is gone.
    const sessionB = await pageB.request.get(
      `${API_BASE_URL}/api/auth/get-session?disableCookieCache=true`
    );
    const sessionBodyB = (await sessionB.json()) as { user?: { id?: string } } | null;
    expect(sessionBodyB?.user).toBeFalsy();

    await contextA.close();
    await contextB.close();
  });
});
