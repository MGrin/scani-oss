/**
 * SC-1609: the outbox dispatcher, against a real database and a recording
 * publisher. Rows are committed, because the dispatcher reads what other
 * transactions committed; each test owns its users and deletes them, which
 * takes their outbox rows with them.
 *
 * The falsifier's receive arm needs a control that can fail: a receiver on
 * another user's channel must read 0.
 */

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://dummy:dummy@localhost/dummy';

import { afterAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { withAdvisoryLock } from '@scani/db';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { channelForUser } from '@scani/realtime';
import { OUTBOX_MESSAGE_TYPE, outboxMessageSchema } from '@scani/shared';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { Container } from 'typedi';
import { OutboxEventRepository } from '../../../src/repositories/OutboxEventRepository';
import {
  nextQuarterSweep,
  OutboxDispatcher,
  type OutboxPublisher,
} from '../../../src/services/outbox/OutboxDispatcher';
import { OutboxWriter } from '../../../src/services/outbox/OutboxWriter';
import { restoreContainerAfterAll } from '../../../test/helpers/container';

restoreContainerAfterAll();

const users: string[] = [];

async function makeUser(): Promise<string> {
  const [usd] = await db
    .select({ id: schema.tokens.id })
    .from(schema.tokens)
    .where(and(eq(schema.tokens.symbol, 'USD'), eq(schema.tokens.isActive, true)));
  const [user] = await db
    .insert(schema.users)
    .values({
      email: `outbox-${randomUUID()}@scani.local`,
      name: 'Outbox',
      baseCurrencyId: usd!.id,
    })
    .returning();
  users.push(user!.id);
  return user!.id;
}

afterAll(async () => {
  if (users.length) await db.delete(schema.users).where(inArray(schema.users.id, users));
});

interface Received {
  channel: string;
  id: string;
  at: number;
}

/** Records what was published; `down` makes every publish fail like a dead Redis. */
function recordingPublisher(): OutboxPublisher & { received: Received[]; down: boolean } {
  const self = {
    received: [] as Received[],
    down: false,
    async publish(channel: string, message: string) {
      if (self.down) throw new Error('connect ECONNREFUSED 127.0.0.1:6379');
      const parsed = outboxMessageSchema.parse(JSON.parse(message));
      self.received.push({ channel, id: parsed.id, at: Date.now() });
    },
  };
  return self;
}

async function appendCommitted(userId: string, n: number): Promise<number[]> {
  const writer = Container.get(OutboxWriter);
  return db.transaction(async (tx) => {
    const ids: number[] = [];
    for (let i = 0; i < n; i++) {
      ids.push(
        await writer.append(tx, userId, 'total.delta', {
          v: 1,
          baseCurrencyId: randomUUID(),
          delta: String(i),
        })
      );
    }
    return ids;
  });
}

const onChannel = (rx: Received[], userId: string) =>
  rx.filter((r) => r.channel === channelForUser(userId));

async function unpublishedFor(userId: string) {
  return db
    .select({ id: schema.outboxEvents.id })
    .from(schema.outboxEvents)
    .where(and(eq(schema.outboxEvents.userId, userId), isNull(schema.outboxEvents.publishedAt)));
}

async function drain(publisher: OutboxPublisher) {
  const dispatcher = Container.get(OutboxDispatcher);
  let total = 0;
  for (;;) {
    const outcome = await dispatcher.dispatchBatch(publisher);
    total += outcome.published;
    if (outcome.failed || outcome.read === 0) return { total, failed: outcome.failed };
  }
}

describe('OutboxDispatcher.dispatchBatch', () => {
  test('100 events from one commit are each published once, in id order, on the owner channel', async () => {
    const userId = await makeUser();
    const other = await makeUser();
    const ids = await appendCommitted(userId, 100);
    const publisher = recordingPublisher();
    await drain(publisher);
    const mine = onChannel(publisher.received, userId);
    expect(mine.map((r) => Number(r.id))).toEqual(ids);
    // The control: a receiver on another user's channel reads nothing.
    expect(onChannel(publisher.received, other)).toHaveLength(0);
    expect(await unpublishedFor(userId)).toHaveLength(0);
    // Published means published: a second pass sends nothing again.
    const again = recordingPublisher();
    await drain(again);
    expect(onChannel(again.received, userId)).toHaveLength(0);
  });

  test('a rolled-back transaction publishes nothing', async () => {
    const userId = await makeUser();
    const writer = Container.get(OutboxWriter);
    await db
      .transaction(async (tx) => {
        await writer.append(tx, userId, 'total.delta', {
          v: 1,
          baseCurrencyId: randomUUID(),
          delta: '1',
        });
        throw new Error('roll back');
      })
      .catch(() => undefined);
    const publisher = recordingPublisher();
    await drain(publisher);
    expect(onChannel(publisher.received, userId)).toHaveLength(0);
  });

  test('Redis down: nothing published, rows stay; Redis back: all of them, by the same ids', async () => {
    const userId = await makeUser();
    const ids = await appendCommitted(userId, 5);
    const publisher = recordingPublisher();
    publisher.down = true;
    const outcome = await drain(publisher);
    expect(outcome.failed).toBe(true);
    expect(onChannel(publisher.received, userId)).toHaveLength(0);
    expect((await unpublishedFor(userId)).map((r) => r.id)).toEqual(ids);
    publisher.down = false;
    await drain(publisher);
    expect(onChannel(publisher.received, userId).map((r) => Number(r.id))).toEqual(ids);
    expect(await unpublishedFor(userId)).toHaveLength(0);
  });

  test('every message is the outbox envelope and carries its row id', async () => {
    const userId = await makeUser();
    const [id] = await appendCommitted(userId, 1);
    const messages: string[] = [];
    await drain({
      async publish(channel, message) {
        if (channel === channelForUser(userId)) messages.push(message);
      },
    });
    const parsed = outboxMessageSchema.parse(JSON.parse(messages[0]!));
    expect(parsed.type).toBe(OUTBOX_MESSAGE_TYPE);
    expect(parsed.id).toBe(String(id));
    expect(parsed.event).toBe('total.delta');
  });
});

function kickBus() {
  const handlers = new Set<() => void>();
  return {
    onKick(handler: () => void) {
      handlers.add(handler);
      return () => void handlers.delete(handler);
    },
    emit() {
      for (const handler of handlers) handler();
    },
  };
}

async function waitFor(check: () => boolean, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
}

/**
 * A dispatcher on an outbox repository of its own, so "idle costs nothing" is
 * measured on it alone. A count on the shared repository also took reads by
 * anything else in the test process that reads the outbox (SC-1685).
 */
function countedDispatcher(): { dispatcher: OutboxDispatcher; reads: () => number } {
  const shared = Container.get(OutboxEventRepository);
  const repository = new OutboxEventRepository();
  const findUnpublished = repository.findUnpublished.bind(repository);
  let reads = 0;
  repository.findUnpublished = async (limit: number) => {
    reads += 1;
    return findUnpublished(limit);
  };
  Container.set(OutboxEventRepository, repository);
  const dispatcher = new OutboxDispatcher();
  Container.set(OutboxEventRepository, shared);
  return { dispatcher, reads: () => reads };
}

/** Two counted loops on one kick bus, as two workers run them. */
function twoCountedLoops(options: { nextSweepAt?: (now: Date) => Date } = {}) {
  const publisher = recordingPublisher();
  const kicks = kickBus();
  const stop = new AbortController();
  const counted = [countedDispatcher(), countedDispatcher()];
  const loops = counted.map(({ dispatcher }) =>
    dispatcher.run(publisher, { signal: stop.signal, kicks, ...options })
  );
  return {
    reads: () => counted.reduce((n, c) => n + c.reads(), 0),
    async stop() {
      stop.abort();
      await Promise.all(loops);
    },
  };
}

/** Whether a fresh session can take the dispatcher's lock, i.e. nobody holds it. */
async function dispatcherLockFree(): Promise<boolean> {
  const outcome = await withAdvisoryLock('outbox-dispatcher', async () => true);
  if (!outcome.ran) {
    const holders = await db.execute(
      sql`select l.pid, a.application_name, a.state, left(a.query, 80) as query from pg_locks l join pg_stat_activity a using (pid) where l.locktype = 'advisory' and l.granted`
    );
    console.warn('outbox-dispatcher lock is held:', JSON.stringify(holders));
  }
  return outcome.ran;
}

describe('nextQuarterSweep', () => {
  test('fires two minutes past each quarter, with the probes, never between them', () => {
    const at = (iso: string) => nextQuarterSweep(new Date(iso)).toISOString();
    expect(at('2026-10-07T10:00:00.000Z')).toBe('2026-10-07T10:02:00.000Z');
    expect(at('2026-10-07T10:01:59.999Z')).toBe('2026-10-07T10:02:00.000Z');
    expect(at('2026-10-07T10:02:00.000Z')).toBe('2026-10-07T10:17:00.000Z');
    expect(at('2026-10-07T10:40:00.000Z')).toBe('2026-10-07T10:47:00.000Z');
    expect(at('2026-10-07T10:47:30.000Z')).toBe('2026-10-07T11:02:00.000Z');
    expect(at('2026-10-07T23:50:00.000Z')).toBe('2026-10-08T00:02:00.000Z');
  });
});

describe('OutboxDispatcher.run', () => {
  test('one live loop: two dispatchers publish each event once, p95 within 1 s of commit', async () => {
    const userId = await makeUser();
    const publisher = recordingPublisher();
    const kicks = kickBus();
    const stop = new AbortController();
    const a = Container.get(OutboxDispatcher).run(publisher, { signal: stop.signal, kicks });
    const b = new OutboxDispatcher().run(publisher, { signal: stop.signal, kicks });
    await new Promise((r) => setTimeout(r, 300));
    const ids = await appendCommitted(userId, 100);
    // The commit returns here; nothing could be read before it.
    const committedAt = Date.now();
    kicks.emit();
    await waitFor(() => onChannel(publisher.received, userId).length >= ids.length);
    stop.abort();
    await Promise.all([a, b]);
    const mine = onChannel(publisher.received, userId);
    expect(mine.map((r) => Number(r.id))).toEqual(ids);
    const lags = mine.map((r) => r.at - committedAt).sort((x, y) => x - y);
    const p95 = lags[Math.ceil(lags.length * 0.95) - 1]!;
    expect(p95).toBeLessThan(1000);
  }, 20_000);

  test('idle, it reads nothing and holds nothing: no query, no lock, no standby loop', async () => {
    const loops = twoCountedLoops();
    try {
      await new Promise((r) => setTimeout(r, 1_300));
      expect(loops.reads()).toBe(0);
      // A lock held for the worker's life keeps a connection reserved, and a
      // standby retrying it is a query every few seconds: both wake Neon.
      expect(await dispatcherLockFree()).toBe(true);
    } finally {
      await loops.stop();
    }
  }, 10_000);

  test('the control: loops that do query are counted in the same window', async () => {
    const loops = twoCountedLoops({ nextSweepAt: () => new Date(Date.now() + 100) });
    try {
      await new Promise((r) => setTimeout(r, 1_300));
      expect(loops.reads()).toBeGreaterThan(0);
    } finally {
      await loops.stop();
    }
  }, 10_000);

  test("the idle count is the loops' own: another dispatcher's reads are not in it (SC-1685)", async () => {
    let otherTouches = 0;
    const otherStop = new AbortController();
    const other = new OutboxDispatcher().run(recordingPublisher(), {
      signal: otherStop.signal,
      kicks: kickBus(),
      nextSweepAt: () => new Date(Date.now() + 100),
      onTouch: () => {
        otherTouches += 1;
      },
    });
    const loops = twoCountedLoops();
    try {
      await new Promise((r) => setTimeout(r, 1_300));
      expect(otherTouches).toBeGreaterThan(0);
      expect(loops.reads()).toBe(0);
    } finally {
      await loops.stop();
      otherStop.abort();
      await other;
    }
  }, 10_000);

  test('a lost kick costs latency, not the event: the sweep delivers it', async () => {
    const userId = await makeUser();
    const publisher = recordingPublisher();
    const stop = new AbortController();
    const loop = Container.get(OutboxDispatcher).run(publisher, {
      signal: stop.signal,
      kicks: kickBus(),
      nextSweepAt: () => new Date(Date.now() + 300),
    });
    const ids = await appendCommitted(userId, 3);
    await waitFor(() => onChannel(publisher.received, userId).length >= ids.length, 5_000);
    stop.abort();
    await loop;
    expect(onChannel(publisher.received, userId).map((r) => Number(r.id))).toEqual(ids);
  }, 10_000);
});

describe('OutboxDispatcher during a Redis outage', () => {
  test('a publisher that keeps failing does not keep the lock: the drain gives up at the backoff cap', async () => {
    const userId = await makeUser();
    await appendCommitted(userId, 1);
    const publisher = recordingPublisher();
    publisher.down = true;
    const kicks = kickBus();
    const stop = new AbortController();
    const loop = Container.get(OutboxDispatcher).run(publisher, {
      signal: stop.signal,
      kicks,
      maxBackoffMs: 200,
    });
    try {
      kicks.emit();
      // 250ms is already past the 200ms cap: one failed pass, then the lock goes.
      await new Promise((r) => setTimeout(r, 1_000));
      expect(await dispatcherLockFree()).toBe(true);
      expect(await unpublishedFor(userId)).toHaveLength(1);
      publisher.down = false;
      kicks.emit();
      await waitFor(() => onChannel(publisher.received, userId).length >= 1);
    } finally {
      stop.abort();
      await loop;
    }
  }, 10_000);
});

describe('OutboxEventRepository.prunePublished', () => {
  test('deletes rows published before the cutoff and nothing unpublished or newer', async () => {
    const userId = await makeUser();
    const [old, recent, pending] = await appendCommitted(userId, 3);
    const repository = Container.get(OutboxEventRepository);
    await repository.markPublished([old!, recent!]);
    await db
      .update(schema.outboxEvents)
      .set({ publishedAt: new Date(Date.now() - 8 * 86_400_000) })
      .where(eq(schema.outboxEvents.id, old!));
    const deleted = await repository.prunePublished(new Date(Date.now() - 7 * 86_400_000), 1_000);
    expect(deleted).toBeGreaterThanOrEqual(1);
    const left = await db
      .select({ id: schema.outboxEvents.id })
      .from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.userId, userId));
    expect(left.map((r) => r.id).sort((a, b) => a - b)).toEqual([recent!, pending!]);
  });
});

describe('OutboxDispatcher pruning', () => {
  test('a sweep deletes rows published over a week ago; a kick does not', async () => {
    const userId = await makeUser();
    const [old] = await appendCommitted(userId, 1);
    await Container.get(OutboxEventRepository).markPublished([old!]);
    await db
      .update(schema.outboxEvents)
      .set({ publishedAt: new Date(Date.now() - 8 * 86_400_000) })
      .where(eq(schema.outboxEvents.id, old!));
    const exists = async () =>
      (
        await db
          .select({ id: schema.outboxEvents.id })
          .from(schema.outboxEvents)
          .where(eq(schema.outboxEvents.id, old!))
      ).length === 1;
    const kicks = kickBus();
    const stop = new AbortController();
    let sweeps = false;
    const loop = Container.get(OutboxDispatcher).run(recordingPublisher(), {
      signal: stop.signal,
      kicks,
      nextSweepAt: (now) => new Date(now.getTime() + (sweeps ? 200 : 3_600_000)),
    });
    try {
      kicks.emit();
      await new Promise((r) => setTimeout(r, 500));
      expect(await exists()).toBe(true);
      sweeps = true;
      kicks.emit();
      const deadline = Date.now() + 5_000;
      while ((await exists()) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      expect(await exists()).toBe(false);
    } finally {
      stop.abort();
      await loop;
    }
  }, 10_000);
});

describe('OutboxDispatcher touch count', () => {
  test('reports each database touch: a drain per wake, named by its trigger, and a prune per sweep', async () => {
    const touches: Array<{ kind: string; at: Date }> = [];
    const kicks = kickBus();
    const stop = new AbortController();
    let sweeps = false;
    const loop = Container.get(OutboxDispatcher).run(recordingPublisher(), {
      signal: stop.signal,
      kicks,
      nextSweepAt: (now) => new Date(now.getTime() + (sweeps ? 200 : 3_600_000)),
      onTouch: (kind, at) => touches.push({ kind, at }),
    });
    try {
      await new Promise((r) => setTimeout(r, 200));
      expect(touches).toEqual([]);
      kicks.emit();
      await waitFor(() => touches.length >= 1);
      expect(touches.map((t) => t.kind)).toEqual(['drain:kick']);
      sweeps = true;
      kicks.emit();
      await waitFor(() => touches.length >= 4);
      expect(touches.slice(0, 4).map((t) => t.kind)).toEqual([
        'drain:kick',
        'drain:kick',
        'drain:sweep',
        'prune',
      ]);
    } finally {
      stop.abort();
      await loop;
    }
  }, 10_000);
});

describe('OutboxDispatcher at-least-once', () => {
  test('a crash between publish and mark repeats the event with the same id, and nothing else', async () => {
    const userId = await makeUser();
    const ids = await appendCommitted(userId, 2);
    const repository = Container.get(OutboxEventRepository);
    const original = repository.markPublished.bind(repository);
    let failOnce = true;
    repository.markPublished = async (marked: readonly number[]) => {
      if (failOnce) {
        failOnce = false;
        throw new Error('connection lost');
      }
      return original(marked);
    };
    const publisher = recordingPublisher();
    try {
      await expect(Container.get(OutboxDispatcher).dispatchBatch(publisher)).rejects.toThrow();
      await drain(publisher);
    } finally {
      repository.markPublished = original;
    }
    const mine = onChannel(publisher.received, userId).map((r) => Number(r.id));
    // Each id twice: once before the crash, once after. Never a new id.
    expect(mine).toEqual([...ids, ...ids]);
    expect(await unpublishedFor(userId)).toHaveLength(0);
    const rows = await db
      .select({ id: schema.outboxEvents.id })
      .from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.userId, userId))
      // Without an order, a row markPublished rewrote can come back after a
      // later one: CI build 1556 read [217, 216].
      .orderBy(asc(schema.outboxEvents.id));
    expect(rows.map((r) => r.id)).toEqual(ids);
  });
});
