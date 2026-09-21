import { afterEach, describe, expect, test } from 'bun:test';
import {
  cameThroughEdge,
  defaultInflowKey,
  edgeLockRefusal,
  loadRateLimiterConfig,
  type RateLimiterConfig,
  resetRateLimiterConfig,
} from '../src/index';

const SECRET = 's'.repeat(40);
const OFF: RateLimiterConfig = {
  FLY_APP_NAME: 'example-app',
  SCANI_EDGE_SECRET: SECRET,
  SCANI_EDGE_LOCK: 'off',
};
const ENFORCE: RateLimiterConfig = { ...OFF, SCANI_EDGE_LOCK: 'enforce' };

function req(headers: Record<string, string>, path = '/api/auth/sign-in/email-otp'): Request {
  return new Request(`https://api.example${path}`, { method: 'POST', headers });
}

afterEach(() => resetRateLimiterConfig());

describe('cameThroughEdge (SC-1264)', () => {
  test('only the exact secret counts', () => {
    expect(cameThroughEdge(req({ 'x-scani-edge': SECRET }), OFF)).toBe(true);
    expect(cameThroughEdge(req({ 'x-scani-edge': `${SECRET}x` }), OFF)).toBe(false);
    expect(cameThroughEdge(req({ 'x-scani-edge': 't'.repeat(40) }), OFF)).toBe(false);
    expect(cameThroughEdge(req({}), OFF)).toBe(false);
  });

  test('with no secret configured, nothing is trusted', () => {
    const unset: RateLimiterConfig = { SCANI_EDGE_LOCK: 'off' };
    expect(cameThroughEdge(req({ 'x-scani-edge': SECRET }), unset)).toBe(false);
  });
});

describe('edgeLockRefusal (SC-1264)', () => {
  const direct = { 'fly-client-ip': '198.51.100.23' };

  test('off: a direct request is let through', () => {
    expect(edgeLockRefusal(req(direct), OFF)).toBeNull();
  });

  test('enforce: a request that went round Cloudflare is refused 403', () => {
    expect(edgeLockRefusal(req(direct), ENFORCE)?.status).toBe(403);
  });

  test('enforce: one carrying the secret passes', () => {
    expect(edgeLockRefusal(req({ ...direct, 'x-scani-edge': SECRET }), ENFORCE)).toBeNull();
  });

  test('enforce: health checks and private-network callers are never refused', () => {
    expect(edgeLockRefusal(req(direct, '/health'), ENFORCE)).toBeNull();
    expect(edgeLockRefusal(req(direct, '/health/deep'), ENFORCE)).toBeNull();
    expect(edgeLockRefusal(req(direct, '/ready'), ENFORCE)).toBeNull();
    expect(edgeLockRefusal(req({}), ENFORCE)).toBeNull();
  });
});

describe('defaultInflowKey behind Cloudflare (SC-1264)', () => {
  test('through the edge: keyed on cf-connecting-ip, not the edge address', () => {
    const r = req({
      'x-scani-edge': SECRET,
      'cf-connecting-ip': '203.0.113.9',
      'fly-client-ip': '172.64.0.1',
    });
    expect(defaultInflowKey(r, OFF)).toBe('203.0.113.9');
  });

  test('without the header a forged cf-connecting-ip is still ignored', () => {
    const r = req({ 'cf-connecting-ip': '203.0.113.9', 'fly-client-ip': '198.51.100.23' });
    expect(defaultInflowKey(r, OFF)).toBe('198.51.100.23');
  });
});

describe('edge config (SC-1264)', () => {
  test('enforce without a secret refuses to load', () => {
    expect(() => loadRateLimiterConfig({ SCANI_EDGE_LOCK: 'enforce' })).toThrow(
      /SCANI_EDGE_SECRET/
    );
  });

  test('a short secret refuses to load', () => {
    expect(() => loadRateLimiterConfig({ SCANI_EDGE_SECRET: 'short' })).toThrow(
      /SCANI_EDGE_SECRET/
    );
  });
});
