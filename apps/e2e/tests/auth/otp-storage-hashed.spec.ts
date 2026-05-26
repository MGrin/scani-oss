import { expect, test } from '@playwright/test';
import { queryDb } from '../../fixtures/db';
import { mailpit } from '../../fixtures/mailpit';
import { resetAuthRateLimit } from '../../fixtures/redis';

const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:3011';

test.describe('auth: OTP storage is hashed', () => {
  test.beforeEach(resetAuthRateLimit);

  test('user_verifications.value stores the OTP hash, not the plain code', async ({
    page,
  }, testInfo) => {
    const email = `e2e-hash-${testInfo.testId}-${Date.now()}@example.com`;
    const requestRes = await page.request.post(
      `${API_BASE_URL}/api/auth/email-otp/send-verification-otp`,
      {
        data: { email, type: 'sign-in' },
        headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
      }
    );
    expect(requestRes.ok()).toBe(true);

    const message = await mailpit.waitForMessageTo(email);
    const otpPlain = mailpit.extractOtpFromSubject(message.Subject);

    const rows = await queryDb(
      `SELECT value FROM user_verifications WHERE identifier = 'sign-in-otp-${email}' ORDER BY created_at DESC LIMIT 1;`
    );
    expect(rows.length).toBeGreaterThan(0);
    const stored = rows[0] as string;

    // Stored value must NOT equal the plain OTP.
    expect(stored).not.toBe(otpPlain);
    // Stored value should be a base64-ish hash (>=40 chars).
    expect(stored.length).toBeGreaterThanOrEqual(40);
  });
});
