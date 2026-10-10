/**
 * SC-1648. A REST client retries a request whose answer it lost. With the
 * same `Idempotency-Key` the retry writes nothing and answers what the first
 * attempt answered.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { InMemoryInflowRateLimiter } from '@scani/rate-limiter';
import { and, eq } from 'drizzle-orm';
import { Container } from 'typedi';
import { AgentWriteJournal, AgentWriteKeyUnfinishedError } from '../../src/agent-writes/journal';
import { PersonalAccessTokenService } from '../../src/auth/personal-access-tokens';
import { createMcpDeps, handleMcpRequest } from '../../src/mcp/server';
import {
  removeTenants,
  seedBaseCurrency,
  seedTenant,
  suffix,
  type Tenant,
  userData,
} from '../helpers/agent-tenant';
import { roomyHeavyLimiter } from '../helpers/limiters';
import { rest } from '../helpers/rest-client';

let alice: Tenant;

beforeAll(async () => {
  await seedBaseCurrency();
  alice = await seedTenant('alice');
});

afterAll(removeTenants);

const inflow = (amount: string, holdingId = alice.holdingId) => ({
  direction: 'inflow',
  holdingId,
  amount,
  occurredAt: '2026-10-07T09:00:00Z',
});

const post = (token: string, body: unknown, key?: string) =>
  rest(token, 'POST', '/movements', {
    body,
    headers: key === undefined ? {} : { 'idempotency-key': key },
  });

async function movements(): Promise<number> {
  return (
    await db
      .select({ id: schema.holdingTransactions.id })
      .from(schema.holdingTransactions)
      .where(
        and(
          eq(schema.holdingTransactions.userId, alice.userId),
          eq(schema.holdingTransactions.holdingId, alice.holdingId)
        )
      )
  ).length;
}

const key = (name: string) => `${name}-${suffix}`;

describe('Idempotency-Key on a write (SC-1648)', () => {
  test('the same key and body twice writes once, and the second answer says it is a replay', async () => {
    const before = await movements();
    const first = await post(alice.writeToken, inflow('5'), key('twice'));
    expect(first.status).toBe(200);
    expect(first.body.replayed).toBeUndefined();
    const after = await userData(alice.userId);

    const second = await post(alice.writeToken, inflow('5'), key('twice'));
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ ...first.body, replayed: true });
    expect(await movements()).toBe(before + 1);
    expect(await userData(alice.userId)).toEqual(after);
  });

  test('without a key the same body writes twice: the control', async () => {
    const before = await movements();
    const a = await post(alice.writeToken, inflow('6'));
    const b = await post(alice.writeToken, inflow('6'));
    expect(a.body.agentChangeId).not.toBe(b.body.agentChangeId);
    expect(await movements()).toBe(before + 2);
  });

  test('the same key with a different body answers 409 and writes nothing', async () => {
    await post(alice.writeToken, inflow('7'), key('reused'));
    const after = await userData(alice.userId);
    const other = await post(alice.writeToken, inflow('8'), key('reused'));
    expect({ status: other.status, code: other.body.error.code }).toEqual({
      status: 409,
      code: 'conflict',
    });
    expect(other.body.error.message).toContain('Idempotency-Key');
    expect(await userData(alice.userId)).toEqual(after);
  });

  test('a key belongs to its token: the same key from another token is a new write', async () => {
    const first = await post(alice.writeToken, inflow('9'), key('per-token'));
    // The read token cannot write, so mint a second writer.
    const second = await new PersonalAccessTokenService().create(alice.userId, 'second writer', {
      allowWrites: true,
    });
    const other = await post(second.token, inflow('9'), key('per-token'));
    expect(other.status).toBe(200);
    expect(other.body.replayed).toBeUndefined();
    expect(other.body.agentChangeId).not.toBe(first.body.agentChangeId);
  });

  test('a first attempt that failed keeps no key, so the corrected retry runs', async () => {
    const failed = await post(
      alice.writeToken,
      inflow('3', '00000000-0000-4000-8000-000000000000'),
      key('failed-first')
    );
    expect(failed.status).toBeGreaterThanOrEqual(400);

    const before = await movements();
    const retry = await post(alice.writeToken, inflow('3'), key('failed-first'));
    expect(retry.status).toBe(200);
    expect(retry.body.replayed).toBeUndefined();
    expect(await movements()).toBe(before + 1);
  });

  test('an attempt that never finished keeps its key: the retry is refused, not run again', async () => {
    const [token] = await db
      .select({ id: schema.personalAccessTokens.id })
      .from(schema.personalAccessTokens)
      .where(
        and(
          eq(schema.personalAccessTokens.userId, alice.userId),
          eq(schema.personalAccessTokens.name, 'alice writer')
        )
      );
    // What a process killed mid-write leaves: the journal row, the key, no outcome.
    await db.insert(schema.agentWrites).values({
      userId: alice.userId,
      actor: token?.id as string,
      tool: 'record_movement',
      input: inflow('11'),
      status: 'failed',
      idempotencyKey: key('died'),
    });
    const before = await movements();
    const retry = await post(alice.writeToken, inflow('11'), key('died'));
    expect({ status: retry.status, code: retry.body.error.code }).toEqual({
      status: 409,
      code: 'conflict',
    });
    expect(retry.body.error.message).toContain('did not finish');
    expect(await movements()).toBe(before);
  });

  test('a write that failed after changing rows keeps its key, so it cannot run twice', async () => {
    const journal = Container.get(AgentWriteJournal);
    const [holding] = await db
      .select()
      .from(schema.holdings)
      .where(eq(schema.holdings.id, alice.holdingId));
    const opts = {
      userId: alice.userId,
      actor: 'test-actor',
      tool: 'probe',
      input: { n: 1 },
      idempotencyKey: key('half'),
    };
    let runs = 0;
    const half = async () => {
      runs += 1;
      await db.insert(schema.holdingTransactions).values({
        userId: alice.userId,
        holdingId: alice.holdingId,
        tokenId: holding?.tokenId as string,
        kind: 'deposit',
        quantity: '1',
        occurredAt: new Date('2026-10-07T12:00:00Z'),
        source: 'test-fixture',
        externalId: `half-${suffix}-${runs}`,
      });
      throw new Error('boom');
    };
    await expect(journal.record(opts, half)).rejects.toThrow('boom');
    await expect(journal.record(opts, half)).rejects.toBeInstanceOf(AgentWriteKeyUnfinishedError);
    expect(runs).toBe(1);
  });

  test('a replay after the change was undone answers the first answer and writes nothing', async () => {
    const first = await post(alice.writeToken, inflow('4'), key('undone'));
    const undone = await rest(
      alice.writeToken,
      'POST',
      `/changes/${first.body.agentChangeId}/undo`,
      {
        body: {},
      }
    );
    expect(undone.status).toBe(200);
    const after = await userData(alice.userId);

    const replay = await post(alice.writeToken, inflow('4'), key('undone'));
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ...first.body, replayed: true });
    expect(await userData(alice.userId)).toEqual(after);
  });

  test('two requests with one key at the same moment write once', async () => {
    const before = await movements();
    const both = await Promise.all([
      post(alice.writeToken, inflow('2'), key('race')),
      post(alice.writeToken, inflow('2'), key('race')),
    ]);
    const statuses = both.map((r) => r.status).sort();
    // The loser is told to retry (409) or is answered as a replay (200); never a second write.
    expect(statuses[0]).toBe(200);
    expect([200, 409]).toContain(statuses[1] as number);
    expect(await movements()).toBe(before + 1);

    const retry = await post(alice.writeToken, inflow('2'), key('race'));
    expect(retry.body.replayed).toBe(true);
    expect(await movements()).toBe(before + 1);
  });

  test('a key that is empty, too long or not visible ASCII answers 400 and writes nothing', async () => {
    const before = await movements();
    for (const bad of ['', 'a'.repeat(201), 'has space', 'tab\there']) {
      const res = await post(alice.writeToken, inflow('1'), bad);
      expect({ bad, status: res.status, code: res.body.error.code }).toEqual({
        bad,
        status: 400,
        code: 'invalid_input',
      });
      expect(res.body.error.issues.join(' ')).toContain('Idempotency-Key');
    }
    expect((await post(alice.writeToken, inflow('1'), 'a'.repeat(200))).status).toBe(200);
    expect(await movements()).toBe(before + 1);
  });

  test('an undo ignores the header: its repeat is already a 409', async () => {
    const written = await post(alice.writeToken, inflow('1'));
    const path = `/changes/${written.body.agentChangeId}/undo`;
    const headers = { 'idempotency-key': key('undo') };
    expect((await rest(alice.writeToken, 'POST', path, { body: {}, headers })).status).toBe(200);
    expect((await rest(alice.writeToken, 'POST', path, { body: {}, headers })).status).toBe(409);
  });

  test('an MCP write sends no key and is never a replay', async () => {
    const call = async () => {
      const res = await handleMcpRequest(
        new Request('http://localhost/mcp', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${alice.writeToken}`,
            'content-type': 'application/json',
            'idempotency-key': key('mcp'),
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'record_movement', arguments: inflow('1') },
          }),
        }),
        createMcpDeps({
          accessAllowed: async () => true,
          heavyLimiter: roomyHeavyLimiter(),
          limiter: new InMemoryInflowRateLimiter({
            windowMs: 60_000,
            max: 1000,
            namespace: `rl:test-idem-${suffix}`,
          }),
        })
      );
      return ((await res.json()) as { result: { structuredContent: Record<string, unknown> } })
        .result.structuredContent;
    };
    const before = await movements();
    const a = await call();
    const b = await call();
    expect(a.replayed).toBeUndefined();
    expect(b.replayed).toBeUndefined();
    expect(a.agentChangeId).not.toBe(b.agentChangeId);
    expect(await movements()).toBe(before + 2);
  });
});
