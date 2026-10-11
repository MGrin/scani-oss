/**
 * SC-1648. `/api/v1` reads: each route is an agent tool behind the same token,
 * budget, gate and call log as `/mcp`, and a token sees its owner's rows only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { restoreContainerAfterAll } from '@scani/domain/test-helpers';
import { InMemoryInflowRateLimiter } from '@scani/rate-limiter';
import { and, desc, eq } from 'drizzle-orm';
import { Container } from 'typedi';
import { OAuthAccessTokenVerifier } from '../../src/auth/oauth-connector';
import { PersonalAccessTokenService } from '../../src/auth/personal-access-tokens';
import { createMcpDeps, handleMcpRequest } from '../../src/mcp/server';
import { REST_ROUTES } from '../../src/rest/routes';
import {
  removeTenants,
  seedBaseCurrency,
  seedTenant,
  suffix,
  type Tenant,
} from '../helpers/agent-tenant';
import { roomyHeavyLimiter } from '../helpers/limiters';
import { rest, restDeps } from '../helpers/rest-client';

restoreContainerAfterAll();

let alice: Tenant;
let bob: Tenant;

beforeAll(async () => {
  await seedBaseCurrency();
  alice = await seedTenant('alice');
  bob = await seedTenant('bob');
});

afterAll(removeTenants);

/** The query each read needs, for the caller `t`. Every GET route must have a row. */
const QUERY: Record<string, (t: Tenant) => string> = {
  '/portfolio/summary': () => '',
  '/portfolio/allocation': () => '?dimension=account',
  '/portfolio/returns': () => '?window=all',
  '/portfolio/net-worth': () => '?from=2026-01-01&to=2026-10-07',
  '/portfolio/realized-gains': (t) => `?holdingId=${t.holdingId}`,
  '/portfolio/data-quality': () => '',
  '/accounts': () => '',
  '/holdings': () => '',
  '/lots': (t) => `?holdingIds=${t.holdingId}`,
  '/transactions': () => '',
  '/tokens': () => '?query=W',
  '/review-questions': () => '',
  '/changes': () => '',
};

const READS = REST_ROUTES.filter((r) => r.method === 'GET');

async function calls(userId: string) {
  return db
    .select()
    .from(schema.agentCalls)
    .where(eq(schema.agentCalls.userId, userId))
    .orderBy(desc(schema.agentCalls.createdAt));
}

describe('/api/v1 reads (SC-1648)', () => {
  test('every read has a query row', () => {
    expect(READS.map((r) => r.path).filter((path) => !QUERY[path])).toEqual([]);
  });

  for (const route of READS) {
    test(`GET ${route.path} answers its owner, and never with the other user's rows`, async () => {
      const mine = await rest(alice.readToken, 'GET', route.path + QUERY[route.path]?.(alice));
      expect(mine.status).toBe(200);
      expect(mine.headers.get('content-type')).toContain('application/json');
      expect(mine.headers.get('cache-control')).toBe('no-store');
      const raw = JSON.stringify(mine.body);
      for (const theirs of [bob.userId, bob.accountId, bob.holdingId, bob.outflowId]) {
        expect(raw).not.toContain(theirs);
      }
    });
  }

  test('the listing control bites: alice sees her own rows', async () => {
    expect(JSON.stringify((await rest(alice.readToken, 'GET', '/accounts')).body)).toContain(
      alice.accountId
    );
    expect(JSON.stringify((await rest(alice.readToken, 'GET', '/holdings')).body)).toContain(
      alice.holdingId
    );
    expect(JSON.stringify((await rest(alice.readToken, 'GET', '/transactions')).body)).toContain(
      alice.outflowId
    );
  });

  test("naming the other user's holding answers 404, not their data", async () => {
    for (const path of [
      `/lots?holdingIds=${bob.holdingId}`,
      `/portfolio/realized-gains?holdingId=${bob.holdingId}`,
    ]) {
      const res = await rest(alice.readToken, 'GET', path);
      expect({ path, status: res.status, code: res.body.error.code }).toEqual({
        path,
        status: 404,
        code: 'not_found',
      });
    }
  });

  test("filtering by the other user's account returns none of its rows", async () => {
    const res = await rest(alice.readToken, 'GET', `/transactions?accountId=${bob.accountId}`);
    expect(res.status).toBe(200);
    expect(res.body.transactions).toEqual([]);
  });
});

describe('/api/v1 admission (SC-1648)', () => {
  const unauthenticated = (res: Awaited<ReturnType<typeof rest>>) => {
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthenticated');
    expect(res.headers.get('www-authenticate')).toBe('Bearer realm="scani"');
  };

  test('no token, a made-up token and a revoked token answer 401', async () => {
    unauthenticated(await rest(null, 'GET', '/accounts'));
    unauthenticated(await rest(`scani_pat_${'0'.repeat(48)}`, 'GET', '/accounts'));

    const tokens = new PersonalAccessTokenService();
    const minted = await tokens.create(alice.userId, 'soon revoked');
    expect((await rest(minted.token, 'GET', '/accounts')).status).toBe(200);
    expect(await tokens.revoke(alice.userId, minted.id)).toBe(true);
    unauthenticated(await rest(minted.token, 'GET', '/accounts'));
  });

  test('an OAuth access token is not a REST credential, though /mcp takes the same one', async () => {
    const oauth = `scani_oat_${'a'.repeat(40)}`;
    const real = Container.get(OAuthAccessTokenVerifier);
    // A grant the OAuth verifier accepts, so the refusal below is REST's own.
    Container.set(OAuthAccessTokenVerifier, {
      verify: async () => ({
        tokenId: 'oauth:test',
        userId: alice.userId,
        scopes: ['portfolio:read'],
      }),
    } as unknown as OAuthAccessTokenVerifier);
    try {
      const viaMcp = await handleMcpRequest(
        new Request('http://localhost/mcp', {
          method: 'POST',
          headers: { authorization: `Bearer ${oauth}`, 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
        }),
        createMcpDeps({
          accessAllowed: async () => true,
          heavyLimiter: roomyHeavyLimiter(),
          limiter: roomyHeavyLimiter(),
        })
      );
      expect(viaMcp.status).toBe(200);
      unauthenticated(await rest(oauth, 'GET', '/accounts'));
    } finally {
      Container.set(OAuthAccessTokenVerifier, real);
    }
  });

  test('a token in the query string is not read', async () => {
    unauthenticated(await rest(null, 'GET', `/accounts?token=${alice.readToken}`));
  });

  test('agent access off answers 403', async () => {
    const res = await rest(alice.readToken, 'GET', '/accounts', {
      deps: restDeps({ accessAllowed: async () => false }),
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('agent_access_off');
  });

  test('an unknown path and a trailing slash answer 404 as JSON', async () => {
    for (const path of ['/nope', '/accounts/', '/accounts/extra', '']) {
      const res = await rest(alice.readToken, 'GET', path);
      expect({ path, status: res.status, code: res.body?.error?.code }).toEqual({
        path,
        status: 404,
        code: 'not_found',
      });
    }
  });

  test('a path id that is not valid percent-encoding answers 404, with or without a token', async () => {
    for (const token of [null, alice.writeToken]) {
      for (const path of ['/changes/%E0%A4%A/undo', '/review-questions/transfers/%zz/answer']) {
        const res = await rest(token, 'POST', path, { body: {} });
        expect({ path, status: res.status, code: res.body?.error?.code }).toEqual({
          path,
          status: 404,
          code: 'not_found',
        });
      }
    }
  });

  test('a failure outside any tool answers the generic 500, never the raw error', async () => {
    const res = await rest(alice.readToken, 'GET', '/accounts', {
      deps: {
        ...restDeps(),
        verifyToken: async () => {
          throw new Error('connection to 10.0.0.7 refused');
        },
      },
    });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: { code: 'internal', message: 'The request failed on the server. Try again later.' },
    });
  });

  test('a known path under the wrong method answers 405 and names the right one', async () => {
    const res = await rest(alice.readToken, 'DELETE', '/accounts');
    expect(res.status).toBe(405);
    expect(res.body.error.code).toBe('method_not_allowed');
    expect(res.headers.get('allow')).toBe('GET');
    // Two tools share /holdings: the list and the create.
    expect((await rest(alice.readToken, 'PUT', '/holdings')).headers.get('allow')).toBe(
      'GET, POST'
    );
  });
});

describe('/api/v1 input errors (SC-1648)', () => {
  test('a value of the wrong type answers 400 naming the parameter as the client sent it', async () => {
    const cases: [string, string][] = [
      ['/transactions?limit=abc', 'limit'],
      ['/transactions?limit=', 'limit'],
      ['/transactions?limit=1000', 'limit'],
      ['/transactions?holdingId=not-a-uuid', 'holdingId'],
      ['/lots?holdingIds=not-a-uuid', 'holdingIds'],
      ['/portfolio/allocation', 'dimension'],
      ['/transactions?nope=1', 'nope'],
    ];
    for (const [path, name] of cases) {
      const res = await rest(alice.readToken, 'GET', path);
      expect({ path, status: res.status, code: res.body.error.code }).toEqual({
        path,
        status: 400,
        code: 'invalid_input',
      });
      expect(res.body.error.issues.join(' | ')).toContain(`${name}`);
      expect(res.body.error.issues.join(' | ')).not.toContain('holding_id');
    }
  });
});

describe('/api/v1 call log and budget (SC-1648)', () => {
  test('one request writes one call-log row under the tool name; a refused one too', async () => {
    const before = (await calls(bob.userId)).length;
    await rest(bob.readToken, 'GET', '/accounts');
    await rest(bob.readToken, 'GET', '/transactions?limit=abc');
    await rest(bob.readToken, 'GET', '/transactions?nope=1');
    const all = await calls(bob.userId);
    const rows = all.slice(0, all.length - before);
    expect(rows).toHaveLength(3);
    expect(
      rows.map((r) => [r.tool, r.outcome]).sort((a, b) => a.join().localeCompare(b.join()))
    ).toEqual([
      ['list_accounts', 'ok'],
      ['list_transactions', 'refused'],
      ['list_transactions', 'refused'],
    ]);
  });

  test('a request refused before a tool is chosen writes no row', async () => {
    const before = (await calls(bob.userId)).length;
    await rest(bob.readToken, 'GET', '/nope');
    await rest(null, 'GET', '/accounts');
    expect((await calls(bob.userId)).length).toBe(before);
  });

  test('/mcp and /api/v1 spend one budget per token', async () => {
    const limiter = new InMemoryInflowRateLimiter({
      windowMs: 60_000,
      max: 2,
      namespace: `rl:test-shared-${suffix}`,
    });
    const viaMcp = await handleMcpRequest(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { authorization: `Bearer ${alice.readToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      }),
      createMcpDeps({
        accessAllowed: async () => true,
        limiter,
        heavyLimiter: roomyHeavyLimiter(),
      })
    );
    expect(viaMcp.status).toBe(200);

    const deps = restDeps({ limiter });
    expect((await rest(alice.readToken, 'GET', '/accounts', { deps })).status).toBe(200);
    const third = await rest(alice.readToken, 'GET', '/accounts', { deps });
    expect(third.status).toBe(429);
    expect(third.body.error.code).toBe('rate_limited');
    expect(Number(third.headers.get('retry-after'))).toBeGreaterThan(0);

    // The budget is the token's: the same user's other token is not spent.
    expect((await rest(alice.writeToken, 'GET', '/accounts', { deps })).status).toBe(200);
  });

  test('the token used is the one the call log names', async () => {
    await rest(bob.writeToken, 'GET', '/holdings');
    const [row] = await db
      .select()
      .from(schema.agentCalls)
      .where(
        and(eq(schema.agentCalls.userId, bob.userId), eq(schema.agentCalls.tool, 'list_holdings'))
      )
      .orderBy(desc(schema.agentCalls.createdAt))
      .limit(1);
    const [token] = await db
      .select({ id: schema.personalAccessTokens.id })
      .from(schema.personalAccessTokens)
      .where(
        and(
          eq(schema.personalAccessTokens.userId, bob.userId),
          eq(schema.personalAccessTokens.name, 'bob writer')
        )
      );
    expect(row?.actor).toBe(token?.id as string);
  });
});
