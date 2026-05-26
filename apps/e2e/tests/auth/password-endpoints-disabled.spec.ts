import { expect, test } from '@playwright/test';
import { resetAuthRateLimit } from '../../fixtures/redis';

test.describe('auth: password endpoints disabled', () => {
  test.beforeEach(resetAuthRateLimit);

  test('POST /api/auth/sign-up/email returns EMAIL_PASSWORD_SIGN_UP_DISABLED', async ({
    request,
  }) => {
    const res = await request.post('http://localhost:3011/api/auth/sign-up/email', {
      data: { email: 'attacker@example.com', password: 'someverylongpassword123', name: 'x' },
      headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
    });
    expect(res.status()).toBe(400);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('EMAIL_PASSWORD_SIGN_UP_DISABLED');
  });

  test('POST /api/auth/sign-in/email returns EMAIL_PASSWORD_DISABLED', async ({ request }) => {
    const res = await request.post('http://localhost:3011/api/auth/sign-in/email', {
      data: { email: 'someone@example.com', password: 'someverylongpassword123' },
      headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
    });
    expect(res.status()).toBe(400);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('EMAIL_PASSWORD_DISABLED');
  });
});
