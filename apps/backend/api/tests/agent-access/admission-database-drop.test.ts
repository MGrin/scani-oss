/**
 * SC-1762. A token check that cannot reach the database answers 503 with
 * `Retry-After` on /mcp and /api/v1. Production's one event was a Neon compute
 * resuming under a request (2026-10-21T19:00:28Z, `write CONNECT_TIMEOUT`): the
 * token was not known to be bad, so not 401, and nothing in Scani failed, so
 * not 500. A query the database rejects still answers 500.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { db } from '@scani/db/connection';
import { personalAccessTokens } from '@scani/db/schema';
import { InMemoryInflowRateLimiter } from '@scani/rate-limiter';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { type AgentDeps, admit } from '../../src/agent-access/pipeline';
import { createMcpDeps, handleMcpRequest } from '../../src/mcp/server';
import { roomyHeavyLimiter } from '../helpers/limiters';
import { rest, restDeps } from '../helpers/rest-client';

// Accepts the connection and never answers, as a compute that is resuming does.
let silent: Bun.TCPSocketListener;
let client: ReturnType<typeof postgres>;
let dropped: Error;
let rejected: Error;

beforeAll(async () => {
  silent = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  client = postgres(`postgres://scani:scani@127.0.0.1:${silent.port}/scani`, {
    connect_timeout: 1,
    max: 1,
  });
  // The lookup `PersonalAccessTokenService.verify` runs, against that server.
  dropped = await drizzle(client)
    .select()
    .from(personalAccessTokens)
    .where(eq(personalAccessTokens.hashedToken, 'sc1762'))
    .limit(1)
    .then(
      () => new Error('the silent server answered'),
      (error: Error) => error
    );
  rejected = await db.execute(sql`select * from sc1762_no_such_table`).then(
    () => new Error('the database accepted a missing table'),
    (error: Error) => error
  );
});

afterAll(async () => {
  await client.end({ timeout: 0 });
  silent.stop(true);
});

const throwing = (error: Error) => async () => {
  throw error;
};

function mcpRequest(): Request {
  return new Request('http://localhost/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: 'Bearer scani_pat_sc1762',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
}

function mcpDeps(verifyToken: AgentDeps['verifyToken']) {
  return {
    ...createMcpDeps({
      accessAllowed: async () => true,
      limiter: new InMemoryInflowRateLimiter({
        windowMs: 60_000,
        max: 1000,
        namespace: `rl:test-sc1762-${randomUUID()}`,
      }),
      heavyLimiter: roomyHeavyLimiter(),
    }),
    verifyToken,
  };
}

describe('a token check that cannot reach the database (SC-1762)', () => {
  test("the fixture throws production's error: drizzle's failed lookup over CONNECT_TIMEOUT", () => {
    expect(dropped.message).toStartWith('Failed query: select');
    expect(dropped.message).toContain('"personal_access_tokens"."hashed_token" = $1');
    expect((dropped.cause as { code?: string }).code).toBe('CONNECT_TIMEOUT');
  });

  test('admission answers unavailable, with a retry delay', async () => {
    const admission = await admit(mcpRequest(), { ...restDeps(), verifyToken: throwing(dropped) });
    expect(admission).toEqual({ ok: false, reason: 'unavailable', retryAfterSec: 5 });
  });

  test('/api/v1 answers 503 with Retry-After, not 500', async () => {
    const res = await rest('scani_pat_sc1762', 'GET', '/accounts', {
      deps: { ...restDeps(), verifyToken: throwing(dropped) },
    });
    expect({ status: res.status, retryAfter: res.headers.get('retry-after') }).toEqual({
      status: 503,
      retryAfter: '5',
    });
    expect(res.body).toEqual({
      error: { code: 'unavailable', message: 'Scani is briefly unavailable. Try again shortly.' },
    });
  });

  test('/mcp answers 503 with Retry-After, not 500', async () => {
    const res = await handleMcpRequest(mcpRequest(), mcpDeps(throwing(dropped)));
    expect({ status: res.status, retryAfter: res.headers.get('retry-after') }).toEqual({
      status: 503,
      retryAfter: '5',
    });
    expect(await res.json()).toEqual({ error: 'Service Unavailable' });
  });

  test('a Neon suspend ending the connection mid-query reads the same', async () => {
    const closed = Object.assign(new Error('write CONNECTION_CLOSED host:5432'), {
      code: 'CONNECTION_CLOSED',
    });
    const terminated = Object.assign(new Error('terminating connection'), { code: '57P01' });
    for (const cause of [closed, terminated]) {
      const error = new Error('Failed query: select 1', { cause });
      const admission = await admit(mcpRequest(), { ...restDeps(), verifyToken: throwing(error) });
      expect({ code: cause.code, admission }).toEqual({
        code: cause.code,
        admission: { ok: false, reason: 'unavailable', retryAfterSec: 5 },
      });
    }
  });

  test('a query the database rejects stays a 500: that is a fault, not a drop', async () => {
    expect((rejected.cause as { code?: string }).code).toBe('42P01');
    await expect(
      admit(mcpRequest(), { ...restDeps(), verifyToken: throwing(rejected) })
    ).rejects.toBe(rejected);
    const res = await rest('scani_pat_sc1762', 'GET', '/accounts', {
      deps: { ...restDeps(), verifyToken: throwing(rejected) },
    });
    expect(res.status).toBe(500);
  });
});
