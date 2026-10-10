/**
 * SC-1648. A REST write is the MCP write: the same tool, the same journal,
 * the same engine calculator path and the same exact undo. Every case in the
 * shared table runs here with the engine writer guard ON (A5), and one case is
 * run through both transports and compared row for row.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { DatabaseTransaction } from '@scani/db';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { HoldingCacheWriter } from '@scani/domain/services/feeds/HoldingCacheWriter';
import { InMemoryInflowRateLimiter } from '@scani/rate-limiter';
import { Decimal } from '@scani/shared';
import { desc, eq, sql } from 'drizzle-orm';
import { Container } from 'typedi';
import { createMcpDeps, handleMcpRequest } from '../../src/mcp/server';
import { REST_ROUTES } from '../../src/rest/routes';
import {
  removeTenants,
  seedBaseCurrency,
  seedTenant,
  suffix,
  type Tenant,
  userData,
  WRITE_CASES,
} from '../helpers/agent-tenant';
import { roomyHeavyLimiter } from '../helpers/limiters';
import { rest } from '../helpers/rest-client';

let alice: Tenant;
let bob: Tenant;

beforeAll(async () => {
  await seedBaseCurrency();
  alice = await seedTenant('alice');
  bob = await seedTenant('bob');
});

afterAll(removeTenants);

/** A tool call as its REST request: the path's `{name}` taken out of the arguments. */
function asRequest(tool: string, args: Record<string, unknown>) {
  const route = REST_ROUTES.find((r) => r.tool === tool);
  if (!route) throw new Error(`no route for ${tool}`);
  const body = { ...args };
  const path = route.path.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = body[name];
    delete body[name];
    return String(value);
  });
  return { path, body };
}

async function write(t: Tenant, tool: string, args: Record<string, unknown>) {
  const { path, body } = asRequest(tool, args);
  return rest(t.writeToken, 'POST', path, { body });
}

const undo = (t: Tenant, id: string) =>
  rest(t.writeToken, 'POST', `/changes/${id}/undo`, { body: {} });

async function guardState(): Promise<string | undefined> {
  const [row] = await db.execute<{ tgenabled: string }>(sql`
    SELECT tgenabled FROM pg_trigger
    WHERE tgname = 'holdings_engine_writer_guard' AND tgrelid = 'holdings'::regclass
  `);
  return row?.tgenabled;
}

/** Every holding whose stored balance is not the figure the engine computes for it. */
async function staleCaches(userId: string): Promise<string[]> {
  const rows = await db
    .select({ id: schema.holdings.id, balance: schema.holdings.balance })
    .from(schema.holdings)
    .where(eq(schema.holdings.userId, userId));
  const engine = await db.transaction((tx) =>
    Container.get(HoldingCacheWriter).engineBalances(
      userId,
      rows.map((r) => r.id),
      tx as unknown as DatabaseTransaction
    )
  );
  return rows
    .filter((r) => !new Decimal(r.balance).eq(engine.get(r.id) ?? '0'))
    .map((r) => `${r.id}: stored ${r.balance}, engine ${engine.get(r.id)}`);
}

describe('the engine writer guard is on for these tests (A5)', () => {
  test('the trigger is enabled', async () => {
    expect(await guardState()).toBe('O');
  });

  test('the control bites: a balance written outside the calculator is refused', async () => {
    const refused = await db
      .execute(sql`UPDATE holdings SET balance = '999' WHERE id = ${alice.holdingId}`)
      .then(() => null)
      .catch((e: { code?: string; cause?: { code?: string } }) => e.cause?.code ?? e.code);
    expect(refused).toBe('SCE01');
  });
});

describe('a REST write, then its undo, is byte-identical (SC-1648)', () => {
  for (const [label, build] of WRITE_CASES) {
    test(label, async () => {
      const before = await userData(alice.userId);
      const [tool, args] = build(alice);

      const written = await write(alice, tool, args);
      expect({ status: written.status, error: written.body.error }).toEqual({
        status: 200,
        error: undefined,
      });
      expect(typeof written.body.agentChangeId).toBe('string');
      expect(written.body.rowsChanged).toBeGreaterThan(0);
      expect(await userData(alice.userId)).not.toEqual(before);

      // The calculator wrote every balance: none is a figure a writer typed in.
      expect(await guardState()).toBe('O');
      expect(await staleCaches(alice.userId)).toEqual([]);

      const listed = await rest(alice.writeToken, 'GET', '/changes');
      expect(
        listed.body.changes.find((c: { id: string }) => c.id === written.body.agentChangeId)
      ).toMatchObject({ tool, status: 'applied' });

      const undone = await undo(alice, written.body.agentChangeId);
      expect(undone.status).toBe(200);
      expect(undone.body.undone).toBe(true);
      expect(await userData(alice.userId)).toEqual(before);
      expect(await staleCaches(alice.userId)).toEqual([]);
    });
  }
});

describe('one write through both transports leaves the same record (SC-1648)', () => {
  test('record_movement: the journal rows match on tool, input, status and what changed', async () => {
    const args = (t: Tenant) => ({
      direction: 'transfer',
      holdingId: t.holdingId,
      amount: '10',
      feeQuantity: '1',
      occurredAt: '2026-10-02T09:00:00Z',
      destinationAccountId: t.otherAccountId,
    });

    const viaRest = await write(alice, 'record_movement', args(alice));
    expect(viaRest.status).toBe(200);

    const res = await handleMcpRequest(
      new Request('http://localhost/mcp', {
        method: 'POST',
        headers: { authorization: `Bearer ${bob.writeToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'record_movement', arguments: args(bob) },
        }),
      }),
      createMcpDeps({
        accessAllowed: async () => true,
        heavyLimiter: roomyHeavyLimiter(),
        limiter: new InMemoryInflowRateLimiter({
          windowMs: 60_000,
          max: 1000,
          namespace: `rl:test-parity-${suffix}`,
        }),
      })
    );
    const viaMcp = (
      (await res.json()) as { result: { structuredContent: { agentChangeId: string } } }
    ).result.structuredContent;

    const record = async (t: Tenant, id: string) => {
      const [row] = await db.select().from(schema.agentWrites).where(eq(schema.agentWrites.id, id));
      const changes = await db.execute<{ table_name: string; n: number }>(sql`
        SELECT table_name, count(*)::int AS n FROM agent_write_changes
        WHERE write_id = ${id} GROUP BY table_name ORDER BY table_name
      `);
      // Ids differ between two tenants; everything else must not.
      const shape = JSON.stringify(row?.input)
        .replaceAll(t.holdingId, '<holding>')
        .replaceAll(t.otherAccountId, '<account>');
      return {
        tool: row?.tool,
        status: row?.status,
        changeCount: row?.changeCount,
        input: shape,
        changes: [...changes],
      };
    };
    expect(await record(alice, viaRest.body.agentChangeId)).toEqual(
      await record(bob, viaMcp.agentChangeId)
    );

    expect((await undo(alice, viaRest.body.agentChangeId)).status).toBe(200);
  });
});

describe('REST write refusals (SC-1648)', () => {
  const inflow = (t: Tenant) => ({
    direction: 'inflow',
    holdingId: t.holdingId,
    amount: '1',
    occurredAt: '2026-10-06T09:00:00Z',
  });

  async function journalSize(userId: string) {
    return (await db.select().from(schema.agentWrites).where(eq(schema.agentWrites.userId, userId)))
      .length;
  }

  test('a read-only token is refused, and nothing is written or journaled', async () => {
    const before = await userData(alice.userId);
    const journaled = await journalSize(alice.userId);
    const res = await rest(alice.readToken, 'POST', '/movements', { body: inflow(alice) });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('read_only_token');
    expect(await userData(alice.userId)).toEqual(before);
    expect(await journalSize(alice.userId)).toBe(journaled);
  });

  test('a body that is not a JSON object is refused before any tool runs', async () => {
    const before = await userData(alice.userId);
    for (const rawBody of ['', '[]', '{"direction":', '"inflow"', 'null']) {
      const res = await rest(alice.writeToken, 'POST', '/movements', { rawBody });
      expect({ rawBody, status: res.status, code: res.body.error.code }).toEqual({
        rawBody,
        status: 400,
        code: 'invalid_input',
      });
    }
    expect(await userData(alice.userId)).toEqual(before);
  });

  test('a misspelled field is refused by name, not silently dropped', async () => {
    const before = await userData(alice.userId);
    const res = await rest(alice.writeToken, 'POST', '/movements', {
      body: { ...inflow(alice), direction: 'transfer', feeQuanity: '1' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.issues).toEqual(['feeQuanity: unknown field']);
    expect(await userData(alice.userId)).toEqual(before);
  });

  test('a misspelled field inside a nested object is refused by its path', async () => {
    const before = await userData(alice.userId);
    const res = await rest(
      alice.writeToken,
      'POST',
      `/review-questions/balance-gaps/${alice.gapObservationId}/answer`,
      { body: { answer: 'flow', editOutflow: { decision: 'left_control', feeQuanity: '5' } } }
    );
    expect(res.status).toBe(400);
    expect(res.body.error.issues).toEqual(['editOutflow.feeQuanity: not a field of this request']);
    expect(await userData(alice.userId)).toEqual(before);

    const inList = await rest(alice.writeToken, 'POST', '/holdings', {
      body: {
        accountId: alice.accountId,
        holdings: [{ tokenId: alice.holdingId, balance: '1', lable: 'x' }],
      },
    });
    expect(inList.status).toBe(400);
    expect(inList.body.error.issues).toEqual(['holdings.0.lable: not a field of this request']);
    expect(await userData(alice.userId)).toEqual(before);
  });

  test('a field that belongs to another kind of movement is refused, not ignored', async () => {
    const before = await userData(alice.userId);
    const res = await rest(alice.writeToken, 'POST', '/movements', {
      body: { ...inflow(alice), feeQuantity: '1' },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.issues).toEqual(['feeQuantity: not a field of this request']);
    expect(await userData(alice.userId)).toEqual(before);
  });

  test('a body that hides its fields under __proto__ is refused, and nothing runs', async () => {
    const before = await userData(alice.userId);
    for (const wrapper of ['__proto__', 'constructor', 'toString']) {
      const res = await rest(alice.writeToken, 'POST', '/movements', {
        rawBody: `{"${wrapper}":${JSON.stringify(inflow(alice))}}`,
      });
      expect({ wrapper, status: res.status, issues: res.body.error.issues }).toEqual({
        wrapper,
        status: 400,
        issues: [`${wrapper}: unknown field`],
      });
    }
    expect(await userData(alice.userId)).toEqual(before);
  });

  test("answering the other user's question tells nothing a made-up id would not, and changes none of their rows", async () => {
    const theirs = await userData(bob.userId);
    const madeUp = '00000000-0000-4000-8000-000000000000';
    const ask = (kind: 'transfers' | 'balance-gaps', id: string, body: unknown) =>
      rest(alice.writeToken, 'POST', `/review-questions/${kind}/${id}/answer`, { body });
    const shape = (res: Awaited<ReturnType<typeof rest>>) => [res.status, res.body.error?.message];
    const transfer = await rest(
      alice.writeToken,
      'POST',
      `/review-questions/transfers/${bob.outflowId}/answer`,
      { body: { decision: 'left_control' } }
    );
    const gap = await rest(
      alice.writeToken,
      'POST',
      `/review-questions/balance-gaps/${bob.gapObservationId}/answer`,
      { body: { answer: 'growth' } }
    );
    expect(transfer.status).toBe(404);
    // The gap service answers 409 "nothing left to record" for an id it cannot
    // find among this user's gaps, whoever's it is. The same answer either way
    // is the property; the status is the service's own.
    expect(shape(transfer)).toEqual(
      shape(await ask('transfers', madeUp, { decision: 'left_control' }))
    );
    expect(shape(gap)).toEqual(shape(await ask('balance-gaps', madeUp, { answer: 'growth' })));
    expect(await userData(bob.userId)).toEqual(theirs);
  });

  test('an id in the body that disagrees with the path, or a path id that is no id, is refused', async () => {
    const disagrees = await rest(
      alice.writeToken,
      'POST',
      `/review-questions/transfers/${alice.outflowId}/answer`,
      { body: { decision: 'left_control', transactionId: bob.outflowId } }
    );
    expect(disagrees.status).toBe(400);
    expect(disagrees.body.error.issues).toEqual(['transactionId: differs from the path']);

    const notAnId = await rest(
      alice.writeToken,
      'POST',
      '/review-questions/transfers/not-a-uuid/answer',
      { body: { decision: 'left_control' } }
    );
    expect(notAnId.status).toBe(400);
    expect(notAnId.body.error.issues.join(' ')).toContain('transactionId');
  });

  test("a write naming the other user's holding changes none of their rows", async () => {
    const theirs = await userData(bob.userId);
    const res = await rest(alice.writeToken, 'POST', '/movements', { body: inflow(bob) });
    expect({ status: res.status, code: res.body.error.code }).toEqual({
      status: 404,
      code: 'not_found',
    });
    expect(await userData(bob.userId)).toEqual(theirs);
  });

  test("undoing twice answers 409, and undoing the other user's change answers 404", async () => {
    const written = await rest(bob.writeToken, 'POST', '/movements', { body: inflow(bob) });
    const id = written.body.agentChangeId as string;

    const foreign = await undo(alice, id);
    expect({ status: foreign.status, code: foreign.body.error.code }).toEqual({
      status: 404,
      code: 'not_found',
    });

    expect((await undo(bob, id)).status).toBe(200);
    const again = await undo(bob, id);
    expect({ status: again.status, code: again.body.error.code }).toEqual({
      status: 409,
      code: 'conflict',
    });
    expect(again.body.error.message).toContain('Already undone');
  });

  test('a refused write is in the call log as refused, and an applied one names its change', async () => {
    const last = async () =>
      (
        await db
          .select()
          .from(schema.agentCalls)
          .where(eq(schema.agentCalls.userId, bob.userId))
          .orderBy(desc(schema.agentCalls.createdAt))
          .limit(1)
      )[0];

    const refused = await rest(bob.readToken, 'POST', '/movements', { body: inflow(bob) });
    expect(refused.status).toBe(403);
    const refusal = await last();
    expect([refusal?.tool, refusal?.outcome, refusal?.agentWriteId]).toEqual([
      'record_movement',
      'refused',
      null,
    ]);

    const written = await rest(bob.writeToken, 'POST', '/movements', { body: inflow(bob) });
    const row = await last();
    expect([row?.tool, row?.outcome, row?.agentWriteId]).toEqual([
      'record_movement',
      'ok',
      written.body.agentChangeId,
    ]);
    expect((await undo(bob, written.body.agentChangeId)).status).toBe(200);
  });
});
