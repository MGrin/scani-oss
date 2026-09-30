import { describe, expect, test } from 'bun:test';
import { isPrivateSessionRead } from '../../src/lib/private-session-read';

const ORIGIN = 'http://scani-backend.internal:8080';
const req = (path: string, headers: Record<string, string> = {}, method = 'GET') =>
  new Request(`${ORIGIN}${path}`, { method, headers });

describe('isPrivateSessionRead (exempt from the global inflow limiter)', () => {
  test('a get-session read with no fly-client-ip, on Fly, is exempt', () => {
    expect(isPrivateSessionRead(req('/api/auth/get-session', { cookie: 'x=1' }), true)).toBe(true);
  });

  test('the same path through Fly’s public proxy is still limited', () => {
    expect(
      isPrivateSessionRead(req('/api/auth/get-session', { 'fly-client-ip': '203.0.113.9' }), true)
    ).toBe(false);
  });

  test('another path with no fly-client-ip is still limited', () => {
    expect(isPrivateSessionRead(req('/api/auth/sign-in/magic-link', {}, 'POST'), true)).toBe(false);
    expect(isPrivateSessionRead(req('/trpc/holdings.getWithDetails'), true)).toBe(false);
    expect(isPrivateSessionRead(req('/api/auth/get-session-x'), true)).toBe(false);
  });

  test('a non-GET to get-session is still limited', () => {
    expect(isPrivateSessionRead(req('/api/auth/get-session', {}, 'POST'), true)).toBe(false);
  });

  test('off Fly nothing sets fly-client-ip, so its absence proves nothing and nothing is exempt', () => {
    expect(isPrivateSessionRead(req('/api/auth/get-session'), false)).toBe(false);
  });
});
