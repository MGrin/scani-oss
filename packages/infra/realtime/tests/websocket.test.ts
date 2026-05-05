import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Redis } from 'ioredis';
import { channelForUser, WebSocketRealtimeUpdatesService } from '../src/index';

const ORIGINAL_SERVICE_NAME = process.env.SERVICE_NAME;

beforeEach(() => {
  process.env.SERVICE_NAME = 'scani-backend';
});

afterEach(() => {
  if (ORIGINAL_SERVICE_NAME === undefined) delete process.env.SERVICE_NAME;
  else process.env.SERVICE_NAME = ORIGINAL_SERVICE_NAME;
});

interface PublishCall {
  topic: string;
  payload: string;
}

function stubElysiaApp(): { app: unknown; calls: PublishCall[] } {
  const calls: PublishCall[] = [];
  const app = {
    server: {
      publish: (topic: string, payload: string) => {
        calls.push({ topic, payload });
        return 1;
      },
    },
  };
  return { app, calls };
}

interface SubscriberStub {
  subscriber: Redis;
  emitMessage: (channel: string, payload: string) => void;
  psubscribeCalls: string[];
}

function stubSubscriber(): SubscriberStub {
  let pmessageHandler: ((p: string, c: string, m: string) => void) | null = null;
  const psubscribeCalls: string[] = [];
  const subscriber = {
    psubscribe: (pattern: string, cb?: (err: Error | null) => void) => {
      psubscribeCalls.push(pattern);
      cb?.(null);
      return Promise.resolve(1);
    },
    on: (event: string, handler: (p: string, c: string, m: string) => void) => {
      if (event === 'pmessage') pmessageHandler = handler;
    },
  };
  return {
    subscriber: subscriber as unknown as Redis,
    emitMessage: (channel, payload) => {
      if (!pmessageHandler) throw new Error('no pmessage handler registered');
      pmessageHandler('rt:user:*', channel, payload);
    },
    psubscribeCalls,
  };
}

describe('SERVICE_NAME guard', () => {
  // The guard moved out of the constructor (typedi class-field DI
  // races env loading and was firing ~50 spurious Sentry events on
  // backend boot). The check now lives on the api-only entry points
  // — construction itself is inert in any process.

  test('construction is inert when SERVICE_NAME is unset', () => {
    delete process.env.SERVICE_NAME;
    expect(() => new WebSocketRealtimeUpdatesService()).not.toThrow();
  });

  test('construction is inert when SERVICE_NAME is some other value', () => {
    process.env.SERVICE_NAME = 'scani-worker';
    expect(() => new WebSocketRealtimeUpdatesService()).not.toThrow();
  });

  test('setElysiaApp throws when SERVICE_NAME is wrong', () => {
    process.env.SERVICE_NAME = 'scani-worker';
    const svc = new WebSocketRealtimeUpdatesService();
    expect(() => svc.setElysiaApp({})).toThrow(/scani-worker/);
  });

  test('initialize throws when SERVICE_NAME is unset', () => {
    delete process.env.SERVICE_NAME;
    const svc = new WebSocketRealtimeUpdatesService();
    expect(() => svc.initialize()).toThrow(/<unset>/);
  });

  test('setElysiaApp + initialize succeed when SERVICE_NAME=scani-backend', () => {
    process.env.SERVICE_NAME = 'scani-backend';
    const svc = new WebSocketRealtimeUpdatesService();
    expect(() => svc.setElysiaApp({})).not.toThrow();
    expect(() => svc.initialize()).not.toThrow();
    svc.shutdown();
  });
});

describe('connection bookkeeping', () => {
  test('registerConnection assigns a unique id when none is given', () => {
    const svc = new WebSocketRealtimeUpdatesService();
    const a = svc.registerConnection({ userId: 'u1' });
    const b = svc.registerConnection({ userId: 'u1' });
    expect(a).not.toBe(b);
    expect(svc.getStats().totalConnections).toBe(2);
  });

  test('registerConnection respects a caller-supplied connectionId', () => {
    const svc = new WebSocketRealtimeUpdatesService();
    const id = svc.registerConnection({ userId: 'u1', connectionId: 'fixed-id' });
    expect(id).toBe('fixed-id');
  });

  test('multiple connections per user roll up into one totalUsers count', () => {
    const svc = new WebSocketRealtimeUpdatesService();
    svc.registerConnection({ userId: 'u1' });
    svc.registerConnection({ userId: 'u1' });
    svc.registerConnection({ userId: 'u2' });
    const stats = svc.getStats();
    expect(stats.totalConnections).toBe(3);
    expect(stats.totalUsers).toBe(2);
  });

  test('handleDisconnection drops the row and unmaps the user when last conn closes', () => {
    const svc = new WebSocketRealtimeUpdatesService();
    const a = svc.registerConnection({ userId: 'u1' });
    const b = svc.registerConnection({ userId: 'u1' });
    svc.handleDisconnection(a);
    expect(svc.getStats().totalConnections).toBe(1);
    expect(svc.getStats().totalUsers).toBe(1);
    svc.handleDisconnection(b);
    expect(svc.getStats().totalConnections).toBe(0);
    expect(svc.getStats().totalUsers).toBe(0);
  });
});

describe('handleMessage', () => {
  test('subscribe extends the connection subscriptions and acks via sendToUser', () => {
    const svc = new WebSocketRealtimeUpdatesService();
    const { app, calls } = stubElysiaApp();
    svc.setElysiaApp(app);
    const id = svc.registerConnection({ userId: 'u1', initialSubscriptions: [] });

    svc.handleMessage(id, { type: 'subscribe', entityTypes: ['holding', 'token'] });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.topic).toBe('user:u1');
    const wire = JSON.parse(calls[0]?.payload ?? '{}') as Record<string, unknown>;
    expect(wire.type).toBe('subscription_updated');
    expect(wire.subscriptions).toEqual(expect.arrayContaining(['holding', 'token']));
  });

  test('ping replies with a pong via sendToUser', () => {
    const svc = new WebSocketRealtimeUpdatesService();
    const { app, calls } = stubElysiaApp();
    svc.setElysiaApp(app);
    const id = svc.registerConnection({ userId: 'u1' });

    svc.handleMessage(id, { type: 'ping' });

    expect(calls).toHaveLength(1);
    const wire = JSON.parse(calls[0]?.payload ?? '{}') as Record<string, unknown>;
    expect(wire.type).toBe('pong');
  });

  test('handleMessage ignores frames for unknown connections', () => {
    const svc = new WebSocketRealtimeUpdatesService();
    const { app, calls } = stubElysiaApp();
    svc.setElysiaApp(app);
    expect(() => svc.handleMessage('does-not-exist', { type: 'ping' })).not.toThrow();
    expect(calls).toHaveLength(0);
  });

  test('handleMessage parses string-form frames', () => {
    const svc = new WebSocketRealtimeUpdatesService();
    const { app, calls } = stubElysiaApp();
    svc.setElysiaApp(app);
    const id = svc.registerConnection({ userId: 'u1' });
    svc.handleMessage(id, JSON.stringify({ type: 'ping' }));
    expect(calls).toHaveLength(1);
  });
});

describe('sendToUser / deliver', () => {
  test('sendToUser publishes to the user-scoped Elysia topic', () => {
    const svc = new WebSocketRealtimeUpdatesService();
    const { app, calls } = stubElysiaApp();
    svc.setElysiaApp(app);

    svc.sendToUser('u1', 'hello');

    expect(calls).toEqual([{ topic: 'user:u1', payload: 'hello' }]);
  });

  test('broadcast (via base.deliver) publishes locally as well', () => {
    const svc = new WebSocketRealtimeUpdatesService();
    const { app, calls } = stubElysiaApp();
    svc.setElysiaApp(app);

    svc.broadcast({ entityType: 'holding', operationType: 'update', userId: 'u1' });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.topic).toBe('user:u1');
  });

  test('deliveries before setElysiaApp are dropped silently', () => {
    const svc = new WebSocketRealtimeUpdatesService();
    expect(() => svc.sendToUser('u1', 'hello')).not.toThrow();
  });
});

describe('pipeFromRedis', () => {
  test('subscribes to rt:user:* and forwards inbound payloads to the local topic', () => {
    const svc = new WebSocketRealtimeUpdatesService();
    const { app, calls } = stubElysiaApp();
    svc.setElysiaApp(app);
    const sub = stubSubscriber();

    svc.pipeFromRedis(sub.subscriber);

    expect(sub.psubscribeCalls).toEqual(['rt:user:*']);

    sub.emitMessage(channelForUser('u-xyz'), '{"type":"entity_changed"}');

    expect(calls).toEqual([{ topic: 'user:u-xyz', payload: '{"type":"entity_changed"}' }]);
  });

  test('inbound messages on non-matching channels are ignored', () => {
    const svc = new WebSocketRealtimeUpdatesService();
    const { app, calls } = stubElysiaApp();
    svc.setElysiaApp(app);
    const sub = stubSubscriber();
    svc.pipeFromRedis(sub.subscriber);

    sub.emitMessage('something:else', 'payload');
    sub.emitMessage('rt:user:', 'payload');

    expect(calls).toHaveLength(0);
  });
});

describe('initialize / shutdown', () => {
  test('initialize is idempotent (second call is a no-op)', () => {
    const svc = new WebSocketRealtimeUpdatesService();
    // Return a truthy stand-in for a Timeout handle so the guard sees it.
    const fakeHandle = { id: 1 } as unknown as NodeJS.Timeout;
    const setIntervalSpy = mock(() => fakeHandle);
    const original = globalThis.setInterval;
    globalThis.setInterval = setIntervalSpy as unknown as typeof globalThis.setInterval;
    try {
      svc.initialize();
      svc.initialize();
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.setInterval = original;
      svc.shutdown();
    }
  });

  test('shutdown clears connections and the elysia app reference', () => {
    const svc = new WebSocketRealtimeUpdatesService();
    const { app } = stubElysiaApp();
    svc.setElysiaApp(app);
    svc.registerConnection({ userId: 'u1' });
    svc.initialize();
    svc.shutdown();
    expect(svc.getStats().totalConnections).toBe(0);
    expect(svc.getStats().totalUsers).toBe(0);
  });
});
