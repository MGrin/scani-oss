import { afterEach, describe, expect, test } from 'bun:test';
import { TRPCError } from '@trpc/server';
import { loadDemoConfig, resetDemoConfig } from '../../src/config/demo';
import { protectedProcedure, publicProcedure, router } from '../../src/presentation/trpc';

/**
 * SC-466. "All writes rejected at the API boundary, not hidden in the UI."
 *
 * The two procedure builders under test are the SHIPPED ones — every router in
 * this service is built from them, so a middleware deleted from either export
 * turns this file red rather than leaving a re-implementation agreeing with the
 * mistake. The tiny router below only supplies resolvers to reach; the chain
 * being exercised is the real one.
 *
 * Every refusal is paired with the case that must still work. A demo whose
 * reads were also refused would pass a "writes are refused" assertion perfectly
 * and be useless, and a middleware that refused on a normal deployment would
 * take the product down — so `off` is asserted as carefully as `on`.
 */

function withDemoMode(enabled: boolean): void {
  resetDemoConfig();
  if (enabled) process.env.SCANI_DEMO_MODE = '1';
  else delete process.env.SCANI_DEMO_MODE;
  loadDemoConfig();
}

/** Enough context for the logging middleware; nothing here reaches a database. */
function context() {
  return {
    requestId: 'test-request',
    startTime: Date.now(),
    requestCache: new Map<string, unknown>(),
    headers: null,
    sessionRevokeLimiter: null,
    userId: 'user-1',
    email: 'someone@example.com',
    isAuthenticated: true,
    dbUser: null,
  } as unknown as Parameters<typeof probe.createCaller>[0];
}

const probe = router({
  publicRead: publicProcedure.query(() => 'read'),
  publicWrite: publicProcedure.mutation(() => 'wrote'),
  protectedRead: protectedProcedure.query(() => 'read'),
  protectedWrite: protectedProcedure.mutation(() => 'wrote'),
});

afterEach(() => {
  withDemoMode(false);
});

describe('demo mode refuses every mutation at the API boundary', () => {
  test('a public mutation is refused', async () => {
    withDemoMode(true);
    const caller = probe.createCaller(context());
    await expect(caller.publicWrite()).rejects.toThrow(TRPCError);
  });

  test('a protected mutation is refused', async () => {
    withDemoMode(true);
    const caller = probe.createCaller(context());
    await expect(caller.protectedWrite()).rejects.toThrow(TRPCError);
  });

  test('the refusal is FORBIDDEN, not UNAUTHORIZED', async () => {
    // The demo session IS authenticated. Saying otherwise would send the app
    // to a sign-in screen that this deployment refuses to serve.
    withDemoMode(true);
    const caller = probe.createCaller(context());
    const error = await caller.protectedWrite().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TRPCError);
    expect((error as TRPCError).code).toBe('FORBIDDEN');
    expect((error as TRPCError).message).toContain('read-only demo');
  });

  test('the message names the procedure, so a refusal is diagnosable', async () => {
    withDemoMode(true);
    const caller = probe.createCaller(context());
    const error = await caller.publicWrite().catch((e: unknown) => e);
    expect((error as TRPCError).message).toContain('publicWrite');
  });

  test('NEGATIVE CONTROL — queries still resolve, or the demo shows nothing', async () => {
    withDemoMode(true);
    const caller = probe.createCaller(context());
    expect(await caller.publicRead()).toBe('read');
    expect(await caller.protectedRead()).toBe('read');
  });
});

describe('a normal deployment is untouched', () => {
  test('NEGATIVE CONTROL — mutations run when demo mode is off', async () => {
    withDemoMode(false);
    const caller = probe.createCaller(context());
    expect(await caller.publicWrite()).toBe('wrote');
    expect(await caller.protectedWrite()).toBe('wrote');
  });

  test('NEGATIVE CONTROL — a value other than "1" does not enable it', async () => {
    resetDemoConfig();
    process.env.SCANI_DEMO_MODE = 'true';
    loadDemoConfig();
    const caller = probe.createCaller(context());
    expect(await caller.publicWrite()).toBe('wrote');
  });

  test('an unauthenticated caller is still refused by the auth middleware', async () => {
    withDemoMode(false);
    const anonymous = {
      ...context(),
      userId: null,
      isAuthenticated: false,
    } as unknown as Parameters<typeof probe.createCaller>[0];
    const error = await probe
      .createCaller(anonymous)
      .protectedRead()
      .catch((e: unknown) => e);
    expect((error as TRPCError).code).toBe('UNAUTHORIZED');
  });
});
