/**
 * SC-1618's falsifier: an agent call missing from the log.
 *
 * Every tool the server knows is called once, plus the calls that never reach
 * a tool (an unknown name, bad arguments, a write on a read-only token). Each
 * must add exactly one row, naming that tool, with an outcome that matches
 * what the agent was told. The tool list is read from the server's own
 * modules, so a new tool is covered without editing this file.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { DatabaseTransaction } from '@scani/db';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import {
  makeAccount,
  makeHolding,
  makeInstitution,
  makeInstitutionType,
  makeToken,
} from '@scani/domain/test-helpers';
import { InMemoryInflowRateLimiter } from '@scani/rate-limiter';
import { desc, eq, inArray } from 'drizzle-orm';
import { PersonalAccessTokenService } from '../../src/auth/personal-access-tokens';
import { createMcpDeps, handleMcpRequest } from '../../src/mcp/server';
import { MCP_TOOLS } from '../../src/mcp/tools';
import { MCP_WRITE_SUPPORT_TOOLS, MCP_WRITE_TOOLS } from '../../src/mcp/write-tools';
import { appRouter } from '../../src/presentation/router';
import { createAgentContext, setSessionRevokeLimiterForContext } from '../../src/presentation/trpc';
import { roomyHeavyLimiter } from '../helpers/limiters';

const suffix = randomUUID().slice(0, 8);
const seedDb = db as unknown as DatabaseTransaction;
const users: string[] = [];
const tokenIds: string[] = [];
const institutionIds: string[] = [];

interface Tenant {
  userId: string;
  writeToken: string;
  writeTokenName: string;
  readToken: string;
  holdingId: string;
}

let alice: Tenant;
let bob: Tenant;

async function seedTenant(name: string, baseCurrencyId: string): Promise<Tenant> {
  const [user] = await db
    .insert(schema.users)
    .values({ email: `sc1618-${name}-${suffix}@scani.local`, name, baseCurrencyId })
    .returning();
  if (!user) throw new Error(`user insert failed: ${name}`);
  users.push(user.id);
  const type = await makeInstitutionType(seedDb, { code: 'bank' });
  const institution = await makeInstitution(seedDb, { typeId: type.id, name: `${name}-${suffix}` });
  institutionIds.push(institution.id);
  const account = await makeAccount(seedDb, { userId: user.id, institutionId: institution.id });
  const token = await makeToken(seedDb, { symbol: `L${name.toUpperCase()}${suffix}`.slice(0, 18) });
  tokenIds.push(token.id);
  const holding = await makeHolding(seedDb, {
    userId: user.id,
    accountId: account.id,
    tokenId: token.id,
    balance: '10',
  });
  const service = new PersonalAccessTokenService();
  const writeTokenName = `${name} writer`;
  const write = await service.create(user.id, writeTokenName, { allowWrites: true });
  const read = await service.create(user.id, `${name} reader`);
  return {
    userId: user.id,
    writeToken: write.token,
    writeTokenName,
    readToken: read.token,
    holdingId: holding.id,
  };
}

const deps = () =>
  createMcpDeps({
    accessAllowed: async () => true,
    heavyLimiter: roomyHeavyLimiter(),
    limiter: new InMemoryInflowRateLimiter({
      windowMs: 60_000,
      max: 10_000,
      namespace: `rl:test-mcp-calls-${suffix}`,
    }),
  });

async function call(token: string, name: string, args: unknown) {
  const res = await handleMcpRequest(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    }),
    deps()
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    result?: { isError?: boolean; structuredContent?: Record<string, unknown> };
    error?: unknown;
  };
  return { failed: Boolean(body.error) || body.result?.isError === true, body };
}

async function rowsFor(userId: string) {
  return db
    .select()
    .from(schema.agentCalls)
    .where(eq(schema.agentCalls.userId, userId))
    .orderBy(desc(schema.agentCalls.createdAt));
}

beforeAll(async () => {
  setSessionRevokeLimiterForContext(
    new InMemoryInflowRateLimiter({ windowMs: 60_000, max: 1000, namespace: `rl:c-${suffix}` })
  );
  const base = await makeToken(seedDb, {
    symbol: `LB${suffix}`.slice(0, 18),
    name: 'SC-1618 base',
  });
  tokenIds.push(base.id);
  alice = await seedTenant('alice', base.id);
  bob = await seedTenant('bob', base.id);
});

afterAll(async () => {
  await db.delete(schema.users).where(inArray(schema.users.id, users));
  await db.delete(schema.institutions).where(inArray(schema.institutions.id, institutionIds));
  await db.delete(schema.tokens).where(inArray(schema.tokens.id, tokenIds.reverse()));
});

const EVERY_TOOL = [...MCP_TOOLS, ...MCP_WRITE_SUPPORT_TOOLS, ...MCP_WRITE_TOOLS].map(
  (t) => t.name
);

describe('every agent call is logged (SC-1618)', () => {
  test('one row per call, for every tool and for calls that reach no tool', async () => {
    const calls: [token: string, tool: string, args: unknown, expected?: string][] = [
      ...EVERY_TOOL.map((tool): [string, string, unknown] => [alice.writeToken, tool, {}]),
      [alice.writeToken, 'no_such_tool', {}, 'refused'],
      [alice.writeToken, 'get_allocation', { dimension: 42 }, 'refused'],
      [
        alice.readToken,
        'record_movement',
        {
          direction: 'inflow',
          holdingId: alice.holdingId,
          amount: '1',
          occurredAt: '2026-10-07T09:00:00Z',
        },
        'refused',
      ],
      [alice.writeToken, 'list_holdings', {}, 'ok'],
    ];

    for (const [token, tool, args, expected] of calls) {
      const before = (await rowsFor(alice.userId)).length;
      const { failed } = await call(token, tool, args);
      const rows = await rowsFor(alice.userId);
      expect({ tool, added: rows.length - before }).toEqual({ tool, added: 1 });
      const row = rows[0];
      expect(row?.tool).toBe(tool);
      expect(row?.outcome === 'ok').toBe(!failed);
      if (expected) expect(row?.outcome).toBe(expected);
    }
  });

  test('a write names the change it made, and its arguments are kept in short form', async () => {
    const { body } = await call(alice.writeToken, 'record_movement', {
      direction: 'inflow',
      holdingId: alice.holdingId,
      amount: '2',
      occurredAt: '2026-10-07T10:00:00Z',
      note: 'x'.repeat(500),
    });
    const changeId = body.result?.structuredContent?.agentChangeId;
    expect(typeof changeId).toBe('string');
    const [row] = await rowsFor(alice.userId);
    expect(row).toMatchObject({ tool: 'record_movement', outcome: 'ok', agentWriteId: changeId });
    expect(row?.argsSummary.length).toBeLessThanOrEqual(300);
    expect(row?.argsSummary).toContain(alice.holdingId);
  });

  test("each user's log names their own token and holds none of the other's calls", async () => {
    await call(bob.writeToken, 'list_accounts', {});
    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, alice.userId));
    if (!user) throw new Error('alice missing');
    const listed = await appRouter
      .createCaller(createAgentContext(user, 'test'))
      .agentTokens.calls();
    expect(listed.length).toBe((await rowsFor(alice.userId)).length);
    expect(listed.some((c) => c.actorName === alice.writeTokenName)).toBe(true);
    const bobRows = await rowsFor(bob.userId);
    expect(bobRows.length).toBeGreaterThan(0);
    const aliceIds = new Set(listed.map((c) => c.id));
    for (const row of bobRows) expect(aliceIds.has(row.id)).toBe(false);
  });
});
