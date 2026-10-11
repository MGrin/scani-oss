/**
 * SC-1617's falsifier: an agent write followed by its undo leaves the user's
 * data byte-identical, and every write appears in the activity log.
 *
 * "The user's data" is read here independently of the journal: every table
 * with a `user_id` column, plus the three that reach the user through a
 * parent, each row as `to_jsonb`. A table the journal does not track but a
 * write touches shows up as a difference, rather than passing because both
 * sides used one list. The exclusions are named, with the reason.
 */ import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { makeHolding, makeToken } from '@scani/domain/test-helpers';
import { InMemoryInflowRateLimiter } from '@scani/rate-limiter';
import { TRPCError } from '@trpc/server';
import { eq, sql } from 'drizzle-orm';
import { createMcpDeps, handleMcpRequest } from '../../src/mcp/server';
import { appRouter } from '../../src/presentation/router';
import { createAgentContext } from '../../src/presentation/trpc';
import {
  reading,
  removeTenants,
  seedBaseCurrency,
  seedDb,
  seedTenant,
  suffix,
  type Tenant,
  tokenIds,
  userData,
  WRITE_CASES,
} from '../helpers/agent-tenant';
import { roomyHeavyLimiter } from '../helpers/limiters';

let alice: Tenant;
let bob: Tenant;

const deps = () =>
  createMcpDeps({
    accessAllowed: async () => true,
    heavyLimiter: roomyHeavyLimiter(),
    limiter: new InMemoryInflowRateLimiter({
      windowMs: 60_000,
      max: 10_000,
      namespace: `rl:test-mcp-writes-${suffix}`,
    }),
  });

async function rpc(token: string, method: string, params: unknown) {
  const res = await handleMcpRequest(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
    deps()
  );
  expect(res.status).toBe(200);
  return (await res.json()) as {
    result?: {
      isError?: boolean;
      tools?: { name: string }[];
      structuredContent?: Record<string, unknown>;
      content?: { text: string }[];
    };
    error?: unknown;
  };
}

async function call(token: string, name: string, args: Record<string, unknown>) {
  const body = await rpc(token, 'tools/call', { name, arguments: args });
  expect(body.error).toBeUndefined();
  return {
    isError: body.result?.isError === true,
    text: body.result?.content?.[0]?.text ?? '',
    data: body.result?.structuredContent ?? {},
  };
}

async function write(t: Tenant, name: string, args: Record<string, unknown>) {
  const out = await call(t.writeToken, name, args);
  if (out.isError) throw new Error(`${name} failed: ${out.text}`);
  const id = out.data.agentChangeId;
  expect(typeof id).toBe('string');
  expect(out.data.rowsChanged).toBeGreaterThan(0);
  return id as string;
}

async function undo(t: Tenant, id: string) {
  return call(t.writeToken, 'undo_agent_change', { agentChangeId: id });
}

async function changes(t: Tenant) {
  const out = await call(t.writeToken, 'list_agent_changes', {});
  return (out.data.changes ?? []) as { id: string; tool: string; status: string }[];
}
beforeAll(async () => {
  await seedBaseCurrency();
  alice = await seedTenant('alice');
  bob = await seedTenant('bob');
});

afterAll(removeTenants);

describe('agent write, then undo, is byte-identical (SC-1617)', () => {
  for (const [label, build] of WRITE_CASES) {
    test(label, async () => {
      const before = await userData(alice.userId);
      const [tool, args] = build(alice);
      const id = await write(alice, tool, args);

      const after = await userData(alice.userId);
      expect(after).not.toEqual(before);

      const logged = (await changes(alice)).find((c) => c.id === id);
      expect(logged).toMatchObject({ tool, status: 'applied' });

      const undone = await undo(alice, id);
      expect(undone.isError).toBe(false);
      expect(await userData(alice.userId)).toEqual(before);
      expect((await changes(alice)).find((c) => c.id === id)?.status).toBe('undone');
    });
  }

  test('the review question the answer closed is open again after the undo', async () => {
    const listed = await call(alice.writeToken, 'list_review_questions', {});
    expect(listed.text).toContain(alice.outflowId);
  });

  test('an undo is refused, changing nothing, once a later change touched the same rows', async () => {
    const before = await userData(alice.userId);
    const movement = (amount: string, at: string) => ({
      direction: 'inflow',
      holdingId: alice.holdingId,
      amount,
      occurredAt: at,
    });
    const first = await write(alice, 'record_movement', movement('2', '2026-10-03T09:00:00Z'));
    const second = await write(alice, 'record_movement', movement('3', '2026-10-04T09:00:00Z'));
    const between = await userData(alice.userId);

    const refused = await undo(alice, first);
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('changed again');
    expect(await userData(alice.userId)).toEqual(between);

    expect((await undo(alice, second)).isError).toBe(false);
    expect((await undo(alice, first)).isError).toBe(false);
    expect(await userData(alice.userId)).toEqual(before);
  });

  test('a balance answer is not undone once a later change touched the same rows', async () => {
    const before = await userData(alice.userId);
    const answer = await write(alice, 'answer_balance_gap', {
      observationId: alice.gapObservationId,
      answer: 'flow',
      editOutflow: { decision: 'left_control' },
    });
    // A later movement on the same holding rewrites its balance row.
    const later = await write(alice, 'record_movement', {
      direction: 'inflow',
      holdingId: alice.gapHoldingId,
      amount: '9',
      occurredAt: '2026-10-06T11:00:00Z',
    });
    const between = await userData(alice.userId);

    const refused = await undo(alice, answer);
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('changed again');
    expect(await userData(alice.userId)).toEqual(between);

    expect((await undo(alice, later)).isError).toBe(false);
    expect((await undo(alice, answer)).isError).toBe(false);
    expect(await userData(alice.userId)).toEqual(before);
  });

  test('undoing twice is refused', async () => {
    const id = await write(alice, 'record_movement', {
      direction: 'inflow',
      holdingId: alice.holdingId,
      amount: '1',
      occurredAt: '2026-10-05T09:00:00Z',
    });
    expect((await undo(alice, id)).isError).toBe(false);
    const again = await undo(alice, id);
    expect(again.isError).toBe(true);
    expect(again.text).toContain('Already undone');
  });

  test('a cache its evidence disagrees with comes back at the engine figure, and the undo still succeeds (A5 D-17)', async () => {
    const token = await makeToken(seedDb, { symbol: `S${suffix}`.slice(0, 18) });
    tokenIds.push(token.id);
    // Stored 42 against a reading of 40: a cache a writer left stale before the flip.
    const stale = await makeHolding(seedDb, {
      userId: alice.userId,
      accountId: alice.accountId,
      tokenId: token.id,
      balance: '42',
    });
    await reading(alice.userId, stale.id, '40', new Date('2026-09-02T00:00:00Z'));
    const row = async () => {
      const [r] = await db.execute<{ image: string; balance: string }>(sql`
        SELECT (to_jsonb(h) - 'balance')::text AS image, balance FROM holdings h WHERE id = ${stale.id}
      `);
      return r;
    };
    const before = await row();

    const id = await write(alice, 'record_movement', {
      direction: 'inflow',
      holdingId: stale.id,
      amount: '5',
      occurredAt: '2026-10-01T09:00:00Z',
    });
    expect((await row())?.balance).toBe('45');

    expect((await undo(alice, id)).isError).toBe(false);
    const after = await row();
    expect(after?.balance).toBe('40');
    expect(after?.image).toBe(before?.image);
  });
});

describe('write scope and tenancy (SC-1617)', () => {
  test('a read-only token is not offered the write tools, and calling one changes nothing', async () => {
    const listed = await rpc(alice.readToken, 'tools/list', {});
    const names = (listed.result?.tools ?? []).map((t) => t.name);
    expect(names).toContain('list_holdings');
    expect(names).toContain('list_agent_changes');
    expect(names).not.toContain('record_movement');

    const withWrite = await rpc(alice.writeToken, 'tools/list', {});
    expect((withWrite.result?.tools ?? []).map((t) => t.name)).toContain('record_movement');

    const before = await userData(alice.userId);
    const refused = await call(alice.readToken, 'record_movement', {
      direction: 'inflow',
      holdingId: alice.holdingId,
      amount: '1',
      occurredAt: '2026-10-06T09:00:00Z',
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('read-only');
    expect(await userData(alice.userId)).toEqual(before);
  });

  test("a write naming the other user's holding changes none of their rows", async () => {
    const bobBefore = await userData(bob.userId);
    const out = await call(alice.writeToken, 'record_movement', {
      direction: 'inflow',
      holdingId: bob.holdingId,
      amount: '7',
      occurredAt: '2026-10-06T09:00:00Z',
    });
    expect(out.isError).toBe(true);
    expect(await userData(bob.userId)).toEqual(bobBefore);
  });

  test("the other user's change can be neither listed nor undone", async () => {
    const id = await write(bob, 'record_movement', {
      direction: 'inflow',
      holdingId: bob.holdingId,
      amount: '4',
      occurredAt: '2026-10-06T10:00:00Z',
    });
    expect((await changes(alice)).map((c) => c.id)).not.toContain(id);
    const bobAfter = await userData(bob.userId);
    const refused = await undo(alice, id);
    expect(refused.isError).toBe(true);
    expect(await userData(bob.userId)).toEqual(bobAfter);
    // The control: the owner can.
    expect((await undo(bob, id)).isError).toBe(false);
  });

  test('an agent context reaches only the mutations its tool names', async () => {
    const [user] = await db.select().from(schema.users).where(eq(schema.users.id, alice.userId));
    if (!user) throw new Error('alice missing');
    const caller = appRouter.createCaller(
      createAgentContext(user, 'test-token', ['holdings.recordMovement'])
    );
    const refused = await caller.holdings
      .delete({ id: alice.holdingId })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(TRPCError);
    expect((refused as TRPCError).code).toBe('FORBIDDEN');
  });
});
