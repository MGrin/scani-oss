import { expect, test } from '../../fixtures/test';

const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:3011';

test.describe('auth: password endpoints disabled', () => {
  test('POST /api/auth/sign-up/email is not exposed', async ({ request }) => {
    const res = await request.post(`${API_BASE_URL}/api/auth/sign-up/email`, {
      data: { email: 'attacker@example.com', password: 'someverylongpassword123', name: 'x' },
      headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
    });
    expect(res.status()).toBe(404);
  });

  test('POST /api/auth/sign-in/email is not exposed', async ({ request }) => {
    const res = await request.post(`${API_BASE_URL}/api/auth/sign-in/email`, {
      data: { email: 'someone@example.com', password: 'someverylongpassword123' },
      headers: { 'content-type': 'application/json', origin: 'http://localhost:5173' },
    });
    expect(res.status()).toBe(404);
  });
});
