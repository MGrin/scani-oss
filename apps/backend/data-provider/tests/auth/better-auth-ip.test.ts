import { describe, expect, test } from 'bun:test';
import { createCloudBetterAuth } from '../../src/auth/better-auth';
import type { CloudDb } from '../../src/db/connection';

// SC-1351: Better-Auth's default reads the FIRST X-Forwarded-For entry, which
// the client writes. The data-provider is Fly-direct (not behind Cloudflare),
// so Fly's own `fly-client-ip` is the address a client cannot choose.
describe('cloud Better-Auth client IP (SC-1351)', () => {
  test('reads fly-client-ip, never X-Forwarded-For', () => {
    const auth = createCloudBetterAuth({
      db: {} as CloudDb,
      baseURL: 'http://localhost:8082',
      secret: 'test-secret-at-least-32-characters-long',
    });
    expect(auth.options.advanced?.ipAddress?.ipAddressHeaders).toEqual(['fly-client-ip']);
  });
});
