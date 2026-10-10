import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { trpc } from '@elysiajs/trpc';
import { Elysia } from 'elysia';
import { appRouter } from '../../src/presentation/router';
import { createContext } from '../../src/presentation/trpc';
import { registerRestRoutes } from '../../src/rest/handler';
import { removeTenants, seedBaseCurrency, seedTenant, type Tenant } from '../helpers/agent-tenant';
import { restDeps } from '../helpers/rest-client';

// SC-1648. The tRPC plugin turns body parsing on app-wide (SC-1032), so this
// mounts /api/v1 beside it, as index.ts does, and goes through Elysia.

let alice: Tenant;
let app: { handle: (req: Request) => Promise<Response> };

beforeAll(async () => {
  await seedBaseCurrency();
  alice = await seedTenant('alice');
  const elysia = new Elysia().use(trpc(appRouter, { createContext, endpoint: '/trpc' }));
  registerRestRoutes(elysia, restDeps());
  app = elysia;
});

afterAll(removeTenants);

const request = (method: string, path: string, token: string | null, body?: unknown) =>
  app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  );

describe('/api/v1 mounted beside the tRPC plugin (SC-1648)', () => {
  test('a GET with a query string reaches its tool', async () => {
    const res = await request('GET', '/api/v1/transactions?limit=1', alice.readToken);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { transactions: unknown[] }).transactions).toHaveLength(1);
  });

  test('a POST body reaches the handler', async () => {
    const res = await request('POST', '/api/v1/movements', alice.writeToken, {
      direction: 'sideways',
      holdingId: alice.holdingId,
      amount: '1',
      occurredAt: '2026-10-01T09:00:00Z',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { issues: string[] } };
    expect(body.error.issues.join(' ')).toContain('direction');
  });

  test('the bare base, an unknown path and a wrong method answer the JSON error body', async () => {
    for (const [method, path, status] of [
      ['GET', '/api/v1', 404],
      ['GET', '/api/v1/', 404],
      ['GET', '/api/v1/nope/deeper', 404],
      ['PATCH', '/api/v1/accounts', 405],
    ] as const) {
      const res = await request(method, path, alice.readToken);
      expect({ path, status: res.status }).toEqual({ path, status });
      expect(typeof ((await res.json()) as { error: { code: string } }).error.code).toBe('string');
    }
  });
});
