import { afterAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { db } from '@scani/db/connection';
import * as schema from '@scani/db/schema';
import { OutboxWriter } from '@scani/domain/services';
import { channelForUser, OUTBOX_KICK_CHANNEL, RedisRealtimeUpdatesService } from '@scani/realtime';
import { and, eq, inArray } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { Container } from 'typedi';
import { startOutboxDispatchLoop } from '../../src/outbox/outbox-dispatch-loop';

type Hub = {
  all: FakeRedis[];
  published: Array<{ channel: string; message: string }>;
  hashes: Map<string, Map<string, number>>;
  ttls: Map<string, number>;
};

/** One in-process Redis: what one connection publishes, every subscriber hears. */
class FakeRedis {
  readonly listeners = new Set<(channel: string, message: string) => void>();
  readonly subscribed = new Set<string>();
  disconnected = false;
  constructor(
    readonly hub: Hub,
    readonly options: Record<string, unknown> = {}
  ) {
    hub.all.push(this);
  }
  duplicate(options: Record<string, unknown> = {}) {
    return new FakeRedis(this.hub, options);
  }
  async subscribe(channel: string) {
    this.subscribed.add(channel);
  }
  on(_event: 'message', fn: (channel: string, message: string) => void) {
    this.listeners.add(fn);
    return this;
  }
  off(_event: 'message', fn: (channel: string, message: string) => void) {
    this.listeners.delete(fn);
    return this;
  }
  async publish(channel: string, message: string) {
    this.hub.published.push({ channel, message });
    for (const r of this.hub.all) {
      if (r.subscribed.has(channel)) for (const fn of r.listeners) fn(channel, message);
    }
    return 1;
  }
  async hincrby(key: string, field: string, by: number) {
    const hash = this.hub.hashes.get(key) ?? new Map<string, number>();
    hash.set(field, (hash.get(field) ?? 0) + by);
    this.hub.hashes.set(key, hash);
    return hash.get(field);
  }
  async expire(key: string, seconds: number) {
    this.hub.ttls.set(key, seconds);
    return 1;
  }
  disconnect() {
    this.disconnected = true;
  }
}

const users: string[] = [];
afterAll(async () => {
  if (users.length) await db.delete(schema.users).where(inArray(schema.users.id, users));
});

async function makeUser(): Promise<string> {
  const [usd] = await db
    .select({ id: schema.tokens.id })
    .from(schema.tokens)
    .where(and(eq(schema.tokens.symbol, 'USD'), eq(schema.tokens.isActive, true)));
  const [user] = await db
    .insert(schema.users)
    .values({
      email: `outbox-loop-${randomUUID()}@scani.local`,
      name: 'Outbox',
      baseCurrencyId: usd!.id,
    })
    .returning();
  users.push(user!.id);
  return user!.id;
}

describe('the worker outbox loop (SC-1609)', () => {
  test("a writer's kick reaches the loop, and the event reaches its owner's channel", async () => {
    const hub: Hub = { all: [], published: [], hashes: new Map(), ttls: new Map() };
    const base = new FakeRedis(hub);
    const realtime = Container.get(RedisRealtimeUpdatesService);
    realtime.configure(base.duplicate() as unknown as Redis);
    const loop = await startOutboxDispatchLoop(base as unknown as Redis);
    try {
      const userId = await makeUser();
      await db.transaction((tx) =>
        Container.get(OutboxWriter).append(tx, userId, 'total.delta', {
          v: 1,
          baseCurrencyId: randomUUID(),
          delta: '1',
        })
      );
      Container.get(OutboxWriter).kick();
      const deadline = Date.now() + 5_000;
      while (
        !hub.published.some((p) => p.channel === channelForUser(userId)) &&
        Date.now() < deadline
      ) {
        await Bun.sleep(20);
      }
      expect(hub.published.some((p) => p.channel === OUTBOX_KICK_CHANNEL)).toBe(true);
      expect(hub.published.filter((p) => p.channel === channelForUser(userId))).toHaveLength(1);
    } finally {
      await loop.stop();
    }
    const [kicks, publisher] = hub.all.slice(2);
    expect(kicks?.subscribed.has(OUTBOX_KICK_CHANNEL)).toBe(true);
    // A publish to a dead Redis must reject, not wait for a reconnect.
    expect(publisher?.options.enableOfflineQueue).toBe(false);
    expect(kicks?.disconnected && publisher?.disconnected).toBe(true);
    // Each drain is counted per UTC day and minute, so a day's touches can be
    // checked against the wake minutes (feeds #23020).
    const [day] = [...hub.hashes.keys()];
    expect(day).toMatch(/^outbox:touches:\d{4}-\d{2}-\d{2}$/);
    const fields = [...hub.hashes.get(day!)!.keys()];
    expect(fields.every((f) => /^\d{2}:\d{2}:(drain:kick|drain:sweep|prune)$/.test(f))).toBe(true);
    expect(fields.some((f) => f.endsWith(':drain:kick'))).toBe(true);
    expect(hub.ttls.get(day!)).toBe(8 * 86_400);
  }, 15_000);
});
