import { describe, expect, test } from 'bun:test';
import { createCloudAuthGate, isCloudAuthSend } from '../../src/auth/cloud-auth-limit';

function otp(ip: string, method = 'POST', path = '/api/auth/email-otp/send-verification-otp') {
  return new Request(`https://api.cloud.example${path}`, {
    method,
    headers: { 'fly-client-ip': ip },
  });
}

describe('cloud auth gate (SC-1260)', () => {
  test('one IP is refused past its hourly budget, with Retry-After', async () => {
    const gate = createCloudAuthGate(null, { perIpPerHour: 2, globalPerHour: 100 });
    expect(await gate(otp('198.51.100.1'))).toBeNull();
    expect(await gate(otp('198.51.100.1'))).toBeNull();
    const refused = await gate(otp('198.51.100.1'));
    expect(refused?.status).toBe(429);
    expect(Number(refused?.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await gate(otp('198.51.100.2'))).toBeNull();
  });

  test('rotating IPs still runs out of the shared budget', async () => {
    const gate = createCloudAuthGate(null, { perIpPerHour: 5, globalPerHour: 3 });
    for (const ip of ['203.0.113.1', '203.0.113.2', '203.0.113.3']) {
      expect(await gate(otp(ip))).toBeNull();
    }
    expect((await gate(otp('203.0.113.4')))?.status).toBe(429);
  });

  test('session reads and sign-out are never counted', async () => {
    const gate = createCloudAuthGate(null, { perIpPerHour: 1, globalPerHour: 1 });
    for (let i = 0; i < 5; i++) {
      expect(await gate(otp('192.0.2.9', 'GET', '/api/auth/get-session'))).toBeNull();
      expect(await gate(otp('192.0.2.9', 'POST', '/api/auth/sign-out'))).toBeNull();
    }
    expect(await gate(otp('192.0.2.9'))).toBeNull();
  });

  test.each([
    ['POST', '/api/auth/sign-in/magic-link', true],
    ['POST', '/api/auth/sign-in/email-otp', true],
    ['POST', '/api/auth/email-otp/send-verification-otp', true],
    ['POST', '/api/auth/sign-up/email', true],
    ['GET', '/api/auth/sign-in/magic-link', false],
    ['POST', '/api/auth/sign-out', false],
  ] as const)('%s %s counted: %s', (method, path, counted) => {
    expect(isCloudAuthSend(method, path)).toBe(counted);
  });
});
