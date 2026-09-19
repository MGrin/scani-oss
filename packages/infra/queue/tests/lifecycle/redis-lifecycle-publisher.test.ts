import { afterAll, describe, expect, test } from 'bun:test';
import Redis from 'ioredis';
import { RedisLifecyclePublisher } from '../../src/lifecycle/redis-lifecycle-publisher';

interface StubRedisCall {
  channel: string;
  message: string;
}

function stubRedis() {
  const calls: StubRedisCall[] = [];
  return {
    calls,
    redis: {
      publish: (channel: string, message: string) => {
        calls.push({ channel, message });
        return 1;
      },
    },
  };
}

describe('RedisLifecyclePublisher — wire shape (must match RealTimeUpdatesService)', () => {
  test('publishes to rt:user:<userId> channel', async () => {
    const { calls, redis } = stubRedis();
    const pub = new RedisLifecyclePublisher();
    pub.configure(redis as never);
    await pub.publish('user-1', 'job-1', { state: 'active', attemptsMade: 1, attemptsAllowed: 3 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.channel).toBe('rt:user:user-1');
  });

  test('message envelope matches RealTimeUpdatesService entity_changed shape', async () => {
    const { calls, redis } = stubRedis();
    const pub = new RedisLifecyclePublisher();
    pub.configure(redis as never);
    await pub.publish('user-1', 'job-9', { state: 'completed', result: { ok: true } });
    const parsed = JSON.parse(calls[0]?.message ?? '{}');
    expect(parsed.type).toBe('entity_changed');
    expect(parsed.entityType).toBe('job');
    expect(parsed.entityId).toBe('job-9');
    expect(parsed.operationType).toBe('sync');
    expect(parsed.data).toEqual({ state: 'completed', result: { ok: true } });
    expect(typeof parsed.timestamp).toBe('string');
  });

  test('maps state→operation: queued=create, active/progress=update, completed=sync, failed=delete', async () => {
    const { calls, redis } = stubRedis();
    const pub = new RedisLifecyclePublisher();
    pub.configure(redis as never);
    for (const state of ['queued', 'active', 'progress', 'completed', 'failed'] as const) {
      await pub.publish('u', 'j', { state });
    }
    const ops = calls.map((c) => JSON.parse(c.message).operationType);
    expect(ops).toEqual(['create', 'update', 'update', 'sync', 'delete']);
  });

  test('publish failures are swallowed (best-effort fan-out)', async () => {
    const pub = new RedisLifecyclePublisher();
    pub.configure({
      publish: () => {
        throw new Error('redis down');
      },
    } as never);
    await expect(pub.publish('u', 'j', { state: 'active' })).resolves.toBeUndefined();
  });

  test('warns + skips when not configured rather than throwing', async () => {
    const pub = new RedisLifecyclePublisher();
    await expect(pub.publish('u', 'j', { state: 'active' })).resolves.toBeUndefined();
  });
});

/**
 * SC-1027. "Best-effort, continuing" needs the publish to REJECT, and the
 * shared client never does: it is built exactly as below,
 * `maxRetriesPerRequest: null`. `UserJobProcessor` awaits this on every job,
 * so before the bound a Redis outage parked every user job here (measured:
 * still pending after 4000ms). Nothing listens on port 1.
 */
describe('RedisLifecyclePublisher against an unreachable Redis (SC-1027)', () => {
  const dead = new Redis('redis://127.0.0.1:1', { maxRetriesPerRequest: null });
  dead.on('error', () => undefined);
  afterAll(() => dead.disconnect());

  const PENDING = Symbol('pending');
  const within = <T>(work: Promise<T>, ms: number) =>
    Promise.race([work, new Promise<typeof PENDING>((r) => setTimeout(() => r(PENDING), ms))]);

  test('a publish gives up inside its bound and the job carries on', async () => {
    const pub = new RedisLifecyclePublisher();
    pub.configure(dead);
    const started = performance.now();
    expect(await within(pub.publish('user-1', 'job-1', { state: 'active' }), 2000)).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test('the control: the client itself still never answers', async () => {
    expect(await within(dead.publish('rt:user:x', '{}'), 1000)).toBe(PENDING);
  });
});
