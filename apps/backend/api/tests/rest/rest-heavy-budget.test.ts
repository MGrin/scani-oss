/**
 * SC-1648, ruled after SC-1671: the four heavy reads share a small budget per
 * USER, across that user's tokens and across both transports, so a script
 * polling returns cannot stall the API.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { InMemoryInflowRateLimiter } from '@scani/rate-limiter';
import { desc, eq } from 'drizzle-orm';
import { AGENT_HEAVY_READS_PER_MINUTE } from '../../src/agent-access/limits';
import { ALL_TOOLS } from '../../src/agent-access/pipeline';
import { createMcpDeps, handleMcpRequest } from '../../src/mcp/server';
import {
  removeTenants,
  seedBaseCurrency,
  seedTenant,
  suffix,
  type Tenant,
} from '../helpers/agent-tenant';
import { rest, restDeps } from '../helpers/rest-client';

let alice: Tenant;
let bob: Tenant;

beforeAll(async () => {
  await seedBaseCurrency();
  alice = await seedTenant('alice');
  bob = await seedTenant('bob');
});

afterAll(removeTenants);

// Windows align to the wall clock, so a budget counted against the real one
// resets whenever a test's calls straddle a minute (main build #1731). Every
// case here reads one fixed instant, mid-minute, instead.
const MID_MINUTE = Date.UTC(2026, 9, 7, 12, 0, 30);
const heavyOf = (max: number, tag: string) =>
  new InMemoryInflowRateLimiter({
    windowMs: 60_000,
    max,
    namespace: `rl:test-heavy-${tag}-${suffix}`,
    now: () => MID_MINUTE,
  });

describe('the heavy-read budget (SC-1648)', () => {
  test('the ruled budget: twelve heavy reads a minute pass, the thirteenth answers 429 with Retry-After', async () => {
    // The number the limiter in index.ts and the published reference both read.
    expect(AGENT_HEAVY_READS_PER_MINUTE).toBe(12);
    const deps = restDeps({ heavyLimiter: heavyOf(AGENT_HEAVY_READS_PER_MINUTE, 'ruled') });
    const heavy = [
      '/portfolio/returns?window=all',
      '/lots',
      '/portfolio/net-worth?from=2026-01-01&to=2026-10-07',
      `/portfolio/realized-gains?holdingId=${alice.holdingId}`,
    ];
    const statuses: number[] = [];
    for (let i = 0; i < AGENT_HEAVY_READS_PER_MINUTE; i++) {
      statuses.push(
        (await rest(alice.readToken, 'GET', heavy[i % heavy.length] as string, { deps })).status
      );
    }
    expect(statuses).toEqual(Array(12).fill(200));

    const thirteenth = await rest(alice.readToken, 'GET', heavy[0] as string, { deps });
    expect({ status: thirteenth.status, code: thirteenth.body.error.code }).toEqual({
      status: 429,
      code: 'rate_limited',
    });
    const wait = Number(thirteenth.headers.get('retry-after'));
    expect(Number.isInteger(wait) && wait >= 1 && wait <= 60).toBe(true);
  });

  test('exactly four tools are heavy', () => {
    expect(
      ALL_TOOLS.filter((t) => t.heavy)
        .map((t) => t.name)
        .sort()
    ).toEqual(['get_net_worth_series', 'get_open_lots', 'get_realized_gains', 'get_returns']);
  });

  test('the third heavy read in a minute answers 429, whichever heavy route or token it is', async () => {
    const deps = restDeps({ heavyLimiter: heavyOf(2, 'rest') });
    const returns = '/portfolio/returns?window=all';
    expect((await rest(alice.readToken, 'GET', returns, { deps })).status).toBe(200);
    expect((await rest(alice.readToken, 'GET', '/lots', { deps })).status).toBe(200);

    const third = await rest(alice.readToken, 'GET', returns, { deps });
    expect(third.status).toBe(429);
    expect(third.body.error.code).toBe('rate_limited');
    expect(Number(third.headers.get('retry-after'))).toBeGreaterThan(0);

    // Per user, not per token: her second token is refused too.
    expect((await rest(alice.writeToken, 'GET', returns, { deps })).status).toBe(429);
    // A light read is untouched, and so is another user.
    expect((await rest(alice.readToken, 'GET', '/accounts', { deps })).status).toBe(200);
    expect((await rest(bob.readToken, 'GET', returns, { deps })).status).toBe(200);
  });

  test('a refused heavy read is in the call log as refused', async () => {
    const deps = restDeps({ heavyLimiter: heavyOf(1, 'log') });
    expect((await rest(bob.readToken, 'GET', '/lots', { deps })).status).toBe(200);
    expect((await rest(bob.readToken, 'GET', '/lots', { deps })).status).toBe(429);
    const [row] = await db
      .select()
      .from(schema.agentCalls)
      .where(eq(schema.agentCalls.userId, bob.userId))
      .orderBy(desc(schema.agentCalls.createdAt))
      .limit(1);
    expect([row?.tool, row?.outcome]).toEqual(['get_open_lots', 'refused']);
  });

  test('the same budget holds over /mcp, where the refusal is a tool error the model can read', async () => {
    const heavyLimiter = heavyOf(1, 'mcp');
    const viaRest = restDeps({ heavyLimiter });
    expect((await rest(alice.readToken, 'GET', '/lots', { deps: viaRest })).status).toBe(200);

    const res = await handleMcpRequest(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { authorization: `Bearer ${alice.readToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'get_returns', arguments: { window: 'all' } },
        }),
      }),
      createMcpDeps({
        accessAllowed: async () => true,
        limiter: heavyOf(1000, 'mcp-token'),
        heavyLimiter,
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { isError?: boolean; content: { text: string }[] };
    };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]?.text).toMatch(/Retry in \d+ seconds/);
  });

  test('an invalid heavy request spends nothing', async () => {
    const deps = restDeps({ heavyLimiter: heavyOf(1, 'invalid') });
    expect((await rest(alice.readToken, 'GET', '/portfolio/returns', { deps })).status).toBe(400);
    expect(
      (await rest(alice.readToken, 'GET', '/portfolio/returns?window=all', { deps })).status
    ).toBe(200);
  });
});
