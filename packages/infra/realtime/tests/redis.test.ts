import { describe, expect, test } from 'bun:test';
import type { Redis } from 'ioredis';
import { channelForUser, RedisRealtimeUpdatesService } from '../src/index';

interface PublishCall {
  channel: string;
  payload: string;
}

function stubRedis(opts: { rejectWith?: Error } = {}): {
  redis: Redis;
  calls: PublishCall[];
} {
  const calls: PublishCall[] = [];
  const redis = {
    publish: (channel: string, payload: string) => {
      calls.push({ channel, payload });
      return opts.rejectWith ? Promise.reject(opts.rejectWith) : Promise.resolve(1);
    },
  };
  return { redis: redis as unknown as Redis, calls };
}

describe('RedisRealtimeUpdatesService', () => {
  test('drops the broadcast when no publisher has been configured', () => {
    const svc = new RedisRealtimeUpdatesService();
    expect(() =>
      svc.broadcast({
        entityType: 'holding',
        operationType: 'update',
        userId: 'u1',
      })
    ).not.toThrow();
  });

  test('publishes to the right channel after configure', () => {
    const svc = new RedisRealtimeUpdatesService();
    const { redis, calls } = stubRedis();
    svc.configure(redis);

    svc.broadcast({
      entityType: 'account',
      operationType: 'create',
      entityId: 'a1',
      userId: 'u1',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.channel).toBe(channelForUser('u1'));
  });

  test('serializes the event payload as JSON with the expected wire shape', () => {
    const svc = new RedisRealtimeUpdatesService();
    const { redis, calls } = stubRedis();
    svc.configure(redis);

    svc.broadcast({
      entityType: 'token',
      operationType: 'update',
      entityId: 't1',
      userId: 'u1',
      data: { price: '42.0' },
    });

    const wire = JSON.parse(calls[0]?.payload ?? '{}') as Record<string, unknown>;
    expect(wire.type).toBe('entity_changed');
    expect(wire.entityType).toBe('token');
    expect(wire.operationType).toBe('update');
    expect(wire.entityId).toBe('t1');
    expect(wire.data).toEqual({ price: '42.0' });
  });

  test('replacing the publisher routes subsequent broadcasts there', () => {
    const svc = new RedisRealtimeUpdatesService();
    const a = stubRedis();
    const b = stubRedis();
    svc.configure(a.redis);
    svc.configure(b.redis);

    svc.broadcast({ entityType: 'user', operationType: 'update', userId: 'u1' });

    expect(a.calls).toHaveLength(0);
    expect(b.calls).toHaveLength(1);
  });

  test('publish failures are swallowed so they do not break the caller', async () => {
    const svc = new RedisRealtimeUpdatesService();
    const { redis } = stubRedis({ rejectWith: new Error('redis down') });
    svc.configure(redis);

    expect(() =>
      svc.broadcast({ entityType: 'holding', operationType: 'sync', userId: 'u1' })
    ).not.toThrow();

    // Yield so the rejected promise's .catch runs without polluting later
    // tests with an unhandled-rejection warning.
    await Promise.resolve();
  });
});
