import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { trpc } from '@elysiajs/trpc';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { InMemoryInflowRateLimiter } from '@scani/rate-limiter';
import { eq } from 'drizzle-orm';
import { Elysia } from 'elysia';
import { PersonalAccessTokenService } from '../../src/auth/personal-access-tokens';
import { registerMcpRoutes } from '../../src/mcp/routes';
import { createMcpDeps } from '../../src/mcp/server';
import { appRouter } from '../../src/presentation/router';
import { createContext, setSessionRevokeLimiterForContext } from '../../src/presentation/trpc';
import { roomyHeavyLimiter } from '../helpers/limiters';

// SC-1614. The tRPC plugin turns body parsing on app-wide (SC-1032), so a
// route that reads `request` itself finds the stream drained. This mounts /mcp
// beside the plugin, as index.ts does, and posts through Elysia.

let userId: string;
let token: string;

beforeAll(async () => {
  const limiter = () =>
    new InMemoryInflowRateLimiter({
      windowMs: 60_000,
      max: 1000,
      namespace: `rl:t-${randomUUID()}`,
    });
  setSessionRevokeLimiterForContext(limiter());
  const [user] = await db
    .insert(schema.users)
    .values({ email: `sc1614-routes-${randomUUID().slice(0, 8)}@scani.local`, name: 'Routes' })
    .returning();
  if (!user) throw new Error('user insert failed');
  userId = user.id;
  token = (await new PersonalAccessTokenService().create(userId, 'routes')).token;
});

afterAll(async () => {
  await db.delete(schema.users).where(eq(schema.users.id, userId));
});

describe('/mcp mounted beside the tRPC plugin', () => {
  test('a POST body reaches the handler', async () => {
    const app = new Elysia().use(trpc(appRouter, { createContext, endpoint: '/trpc' }));
    registerMcpRoutes(
      app,
      createMcpDeps({
        accessAllowed: async () => true,
        heavyLimiter: roomyHeavyLimiter(),
        limiter: new InMemoryInflowRateLimiter({
          windowMs: 60_000,
          max: 100,
          namespace: `rl:t-${randomUUID()}`,
        }),
      })
    );
    const res = await app.handle(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' }),
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: number; result?: { tools: unknown[] } };
    expect(body.id).toBe(7);
    expect(body.result?.tools.length).toBeGreaterThan(0);
  });

  test('the skill is served without a token, as markdown', async () => {
    const app = new Elysia().use(trpc(appRouter, { createContext, endpoint: '/trpc' }));
    registerMcpRoutes(
      app,
      createMcpDeps({
        accessAllowed: async () => true,
        heavyLimiter: roomyHeavyLimiter(),
        limiter: new InMemoryInflowRateLimiter({
          windowMs: 60_000,
          max: 100,
          namespace: `rl:t-${randomUUID()}`,
        }),
      })
    );
    const res = await app.handle(new Request('http://localhost/mcp/skill.md'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/markdown');
    expect(await res.text()).toStartWith('---\nname: scani\n');
  });
});
