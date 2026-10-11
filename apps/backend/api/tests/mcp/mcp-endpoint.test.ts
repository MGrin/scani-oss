import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { InMemoryInflowRateLimiter } from '@scani/rate-limiter';
import { inArray } from 'drizzle-orm';
import { PersonalAccessTokenService } from '../../src/auth/personal-access-tokens';
import { createMcpDeps, handleMcpRequest, type McpDeps } from '../../src/mcp/server';
import { SCANI_SKILL } from '../../src/mcp/skill';
import { MCP_TOOLS } from '../../src/mcp/tools';
import { MCP_WRITE_SUPPORT_TOOLS, MCP_WRITE_TOOLS } from '../../src/mcp/write-tools';
import { appRouter } from '../../src/presentation/router';
import { createAgentContext, setSessionRevokeLimiterForContext } from '../../src/presentation/trpc';
import { roomyHeavyLimiter } from '../helpers/limiters';

// SC-1614: the /mcp endpoint, everything but tenancy (mcp-tenancy.test.ts).

type User = typeof schema.users.$inferSelect;
const tokens = new PersonalAccessTokenService();
const created: string[] = [];
let alice: User;
let aliceToken: string;
let aliceTokenId: string;

function limiter(max = 1000) {
  return new InMemoryInflowRateLimiter({
    windowMs: 60_000,
    max,
    namespace: `rl:test-mcp-${randomUUID()}`,
  });
}

function deps(overrides: Partial<McpDeps> = {}): McpDeps {
  return {
    ...createMcpDeps({
      accessAllowed: async () => true,
      limiter: limiter(),
      heavyLimiter: roomyHeavyLimiter(),
    }),
    ...overrides,
  };
}

function post(body: unknown, token: string | null = aliceToken): Request {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return new Request('http://localhost/mcp', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function rpc(method: string, params: unknown = {}, d: McpDeps = deps()) {
  const res = await handleMcpRequest(post({ jsonrpc: '2.0', id: 1, method, params }), d);
  expect(res.status).toBe(200);
  return (await res.json()) as { result?: Record<string, unknown>; error?: { code: number } };
}

beforeAll(async () => {
  setSessionRevokeLimiterForContext(limiter());
  const [user] = await db
    .insert(schema.users)
    .values({ email: `sc1614-mcp-${randomUUID().slice(0, 8)}@scani.local`, name: 'Alice' })
    .returning();
  if (!user) throw new Error('user insert failed');
  alice = user;
  created.push(user.id);
  const minted = await tokens.create(alice.id, 'test');
  aliceToken = minted.token;
  aliceTokenId = minted.id;
});

afterAll(async () => {
  await db.delete(schema.users).where(inArray(schema.users.id, created));
});

describe('/mcp authentication', () => {
  test('no token is a 401 that names the scheme', async () => {
    const res = await handleMcpRequest(
      post({ jsonrpc: '2.0', id: 1, method: 'ping' }, null),
      deps()
    );
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toStartWith('Bearer');
  });

  test('an unknown token is a 401', async () => {
    const res = await handleMcpRequest(
      post({ jsonrpc: '2.0', id: 1, method: 'ping' }, 'scani_pat_nope'),
      deps()
    );
    expect(res.status).toBe(401);
  });

  test('a revoked token is a 401', async () => {
    const minted = await tokens.create(alice.id, 'revoked');
    await tokens.revoke(alice.id, minted.id);
    const res = await handleMcpRequest(
      post({ jsonrpc: '2.0', id: 1, method: 'ping' }, minted.token),
      deps()
    );
    expect(res.status).toBe(401);
  });

  test('a closed gate is a 403, asked about the token’s owner', async () => {
    const asked: string[] = [];
    const res = await handleMcpRequest(
      post({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      deps({
        accessAllowed: async (userId) => {
          asked.push(userId);
          return false;
        },
      })
    );
    expect(res.status).toBe(403);
    expect(asked).toEqual([alice.id]);
  });

  test('the per-token budget answers 429 with Retry-After', async () => {
    const d = deps({ limiter: limiter(2) });
    for (let i = 0; i < 2; i++) {
      const ok = await handleMcpRequest(post({ jsonrpc: '2.0', id: i, method: 'ping' }), d);
      expect(ok.status).toBe(200);
    }
    const res = await handleMcpRequest(post({ jsonrpc: '2.0', id: 9, method: 'ping' }), d);
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  test('GET is 405: this server opens no SSE stream', async () => {
    const res = await handleMcpRequest(
      new Request('http://localhost/mcp', {
        method: 'GET',
        headers: { authorization: `Bearer ${aliceToken}` },
      }),
      deps()
    );
    expect(res.status).toBe(405);
  });
});

describe('/mcp protocol', () => {
  test('initialize echoes a supported protocol version and offers tools', async () => {
    const body = await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    });
    expect(body.result?.protocolVersion).toBe('2025-06-18');
    expect(body.result?.capabilities).toMatchObject({ tools: {} });
    expect(body.result?.serverInfo).toMatchObject({ name: 'scani' });
  });

  test('initialize answers its newest version to a version it does not know', async () => {
    const body = await rpc('initialize', { protocolVersion: '1999-01-01', capabilities: {} });
    expect(body.result?.protocolVersion).toBe('2025-11-25');
  });

  test('a notification is accepted with 202 and no body', async () => {
    const res = await handleMcpRequest(
      post({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      deps()
    );
    expect(res.status).toBe(202);
    expect(await res.text()).toBe('');
  });

  test('malformed JSON is a parse error', async () => {
    const res = await handleMcpRequest(post('{not json'), deps());
    const body = (await res.json()) as { error?: { code: number } };
    expect(body.error?.code).toBe(-32700);
  });

  test('an unknown method is method-not-found', async () => {
    const body = await rpc('resources/list');
    expect(body.error?.code).toBe(-32601);
  });

  test('tools/list offers a read-only token only read tools, closed-world and titled', async () => {
    const body = await rpc('tools/list');
    const listed = body.result?.tools as Array<Record<string, unknown>>;
    expect(listed.map((t) => t.name)).toEqual(
      [...MCP_TOOLS, ...MCP_WRITE_SUPPORT_TOOLS].map((t) => t.name)
    );
    for (const tool of listed) {
      expect(tool.title).toBeString();
      expect(tool.description).toBeString();
      expect(tool.inputSchema).toMatchObject({ type: 'object' });
      expect(tool.annotations).toEqual({
        title: tool.title,
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
    }
  });

  test('an unknown tool is invalid params', async () => {
    const body = await rpc('tools/call', { name: 'delete_everything', arguments: {} });
    expect(body.error?.code).toBe(-32602);
  });

  test('bad arguments come back as a tool error the model can read', async () => {
    const body = await rpc('tools/call', { name: 'get_allocation', arguments: { dimension: 'x' } });
    expect(body.result?.isError).toBe(true);
    expect(JSON.stringify(body.result?.content)).toContain('dimension');
  });

  test('a tool call returns text and the same value as structured content', async () => {
    const body = await rpc('tools/call', { name: 'list_accounts', arguments: {} });
    expect(body.result?.isError).toBeFalsy();
    const content = body.result?.content as Array<{ type: string; text: string }>;
    expect(content[0]?.type).toBe('text');
    expect(JSON.parse(content[0]?.text ?? 'null')).toEqual(body.result?.structuredContent);
  });
});

describe('the Scani skill (SC-1618)', () => {
  test('names every tool an agent can be offered', () => {
    const every = [...MCP_TOOLS, ...MCP_WRITE_SUPPORT_TOOLS, ...MCP_WRITE_TOOLS].map((t) => t.name);
    const missing = every.filter((name) => !SCANI_SKILL.includes(`\`${name}\``));
    expect(missing).toEqual([]);
  });

  test('names no tool the server does not have', () => {
    const every = new Set(
      [...MCP_TOOLS, ...MCP_WRITE_SUPPORT_TOOLS, ...MCP_WRITE_TOOLS].map((t) => t.name)
    );
    const named = [...SCANI_SKILL.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((m) => m[1] ?? '');
    const toolLike = named.filter((n) =>
      /^(get|list|plan|record|create|answer|undo|search)_/.test(n)
    );
    expect(toolLike.filter((n) => !every.has(n))).toEqual([]);
  });

  test('is offered as the scani-guide prompt', async () => {
    const listed = await rpc('prompts/list');
    expect(((listed.result?.prompts ?? []) as { name: string }[]).map((p) => p.name)).toEqual([
      'scani-guide',
    ]);
    const got = await rpc('prompts/get', { name: 'scani-guide' });
    const messages = (got.result?.messages ?? []) as { content: { text: string } }[];
    expect(messages[0]?.content.text).toBe(SCANI_SKILL);
    expect((await rpc('prompts/get', { name: 'nope' })).error?.code).toBe(-32602);
  });
});

describe('agent context', () => {
  test('refuses every mutation, whatever the tool layer asks for', async () => {
    const caller = appRouter.createCaller(createAgentContext(alice, aliceTokenId));
    await expect(caller.users.updateCurrent({ name: 'Mallory' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(caller.accounts.getByUserIdWithSummary()).resolves.toBeDefined();
  });

  test('cannot pass a fresh-session check', async () => {
    const ctx = createAgentContext(alice, aliceTokenId);
    expect(ctx.sessionCreatedAt).toBeNull();
  });
});
