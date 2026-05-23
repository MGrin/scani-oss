import { describe, expect, test } from 'bun:test';
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
