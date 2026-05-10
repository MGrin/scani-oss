import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installWaitlistCloudDb, waitlistRouter } from '../../../src/presentation/routers/waitlist';
import { buildUnauthedContext } from '../../helpers/test-context';

// The waitlist router is intentionally `publicProcedure` — no bearer
// token required. Each call from the landing page passes through three
// gates: zod validation → in-memory rate limiter (3/h/IP) → CloudDb
// insert. These tests cover the first two; the DB-mediated paths
// (idempotent insert, ops notification) are exercised by the manual
// integration steps in the PR's verification plan.

beforeEach(() => {
  installWaitlistCloudDb(null);
});

afterEach(() => {
  installWaitlistCloudDb(null);
});

describe('waitlistRouter.join — input validation', () => {
  test('rejects an invalid email shape with BAD_REQUEST before touching the limiter or DB', async () => {
    const caller = waitlistRouter.createCaller(buildUnauthedContext({ clientIp: '203.0.113.1' }));
    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: deliberate bad input for test
      caller.join({ email: 'not-an-email' } as any)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  test('rejects an over-long email', async () => {
    const caller = waitlistRouter.createCaller(buildUnauthedContext({ clientIp: '203.0.113.2' }));
    const longLocal = 'a'.repeat(255);
    await expect(caller.join({ email: `${longLocal}@example.com` })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
  });
});

describe('waitlistRouter.join — DB precondition', () => {
  test('returns PRECONDITION_FAILED when no CloudDb is installed', async () => {
    // Use a fresh per-test IP so the in-memory limiter doesn't reject
    // before the DB gate is even reached.
    const caller = waitlistRouter.createCaller(buildUnauthedContext({ clientIp: '203.0.113.3' }));
    await expect(caller.join({ email: 'alice@example.com' })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
  });
});

describe('waitlistRouter.join — rate limiting', () => {
  test('caps the 4th attempt from the same IP at TOO_MANY_REQUESTS', async () => {
    const ip = '203.0.113.99'; // dedicated IP so other suites don't bleed budget
    const caller = waitlistRouter.createCaller(buildUnauthedContext({ clientIp: ip }));

    // First three signups consume the per-IP budget (each call still
    // throws PRECONDITION_FAILED because no DB is wired, but the
    // limiter check runs before the DB check).
    for (let i = 0; i < 3; i++) {
      await expect(caller.join({ email: `r${i}@example.com` })).rejects.toMatchObject({
        code: 'PRECONDITION_FAILED',
      });
    }

    await expect(caller.join({ email: 'r4@example.com' })).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
  });
});
