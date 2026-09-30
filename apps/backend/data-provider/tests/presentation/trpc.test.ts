import { describe, expect, test } from 'bun:test';
import { AppSessionClient } from '../../src/auth/app-session';
import type { DataProviderEnv } from '../../src/config/env';
import {
  bearerProcedure,
  buildCreateContext,
  cookieProcedure,
  publicProcedure,
  router,
} from '../../src/presentation/trpc';

/**
 * The console's session costs a round trip to the api, so only the procedures
 * that need it may pay for it. The landing contact form is public and
 * unauthenticated; resolving a session there would put the api in its path.
 */
function setup() {
  const calls: string[] = [];
  const appSession = new AppSessionClient({
    baseUrl: 'http://api.test:8080',
    fetch: (async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response(
        JSON.stringify({ session: { id: 's1' }, user: { id: 'u1', email: 'a@example.com' } }),
        { headers: { 'content-type': 'application/json' } }
      );
    }) as typeof fetch,
  });
  const createContext = buildCreateContext({
    env: { CLOUD_QUOTA_HOURLY_DEFAULT: null } as DataProviderEnv,
    getCloudDb: () => null,
    appSession,
  });
  const app = router({
    ping: publicProcedure.query(() => 'pong'),
    tenant: bearerProcedure.query(({ ctx }) => ctx.auth.tenantId),
    me: cookieProcedure.query(({ ctx }) => ctx.cloudUser.id),
  });
  const req = () =>
    new Request('http://dp.test/trpc/x', {
      headers: { cookie: '__Secure-scani-app.session_token=abc', authorization: 'Bearer k' },
    });
  return { calls, createContext, app, req };
}

describe('cloud session resolution is lazy', () => {
  test('a public procedure makes no session call', async () => {
    const { calls, createContext, app, req } = setup();
    const caller = app.createCaller(await createContext({ req: req() }));
    expect(await caller.ping()).toBe('pong');
    expect(calls).toHaveLength(0);
  });

  test('a bearer procedure makes no session call', async () => {
    const { calls, createContext, app, req } = setup();
    const caller = app.createCaller(await createContext({ req: req() }));
    expect(await caller.tenant()).toBe('dev');
    expect(calls).toHaveLength(0);
  });

  test('a cookie procedure resolves it, once per request', async () => {
    const { calls, createContext, app, req } = setup();
    const caller = app.createCaller(await createContext({ req: req() }));
    expect(await caller.me()).toBe('u1');
    expect(await caller.me()).toBe('u1');
    expect(calls).toEqual(['http://api.test:8080/api/auth/get-session']);
  });
});
