import { describe, expect, test } from 'bun:test';
import {
  channelForUser,
  REDIS_CHANNEL_PATTERN,
  REDIS_CHANNEL_PREFIX,
  type RealTimeEvent,
  RealtimeUpdatesService,
  userIdFromChannel,
} from '../src/index';

class StubRealtime extends RealtimeUpdatesService {
  delivered: Array<{ userId: string; payload: string }> = [];

  protected deliver(userId: string, payload: string): void {
    this.delivered.push({ userId, payload });
  }
}

function lastPayload(svc: StubRealtime): Record<string, unknown> {
  const last = svc.delivered.at(-1);
  if (!last) throw new Error('no delivery recorded');
  return JSON.parse(last.payload) as Record<string, unknown>;
}

describe('channel naming', () => {
  test('REDIS_CHANNEL_PREFIX is rt:user:', () => {
    expect(REDIS_CHANNEL_PREFIX).toBe('rt:user:');
  });

  test('REDIS_CHANNEL_PATTERN ends in *', () => {
    expect(REDIS_CHANNEL_PATTERN).toBe('rt:user:*');
  });

  test('channelForUser builds the right channel name', () => {
    expect(channelForUser('u_123')).toBe('rt:user:u_123');
  });

  test('userIdFromChannel round-trips channelForUser', () => {
    expect(userIdFromChannel(channelForUser('u_xyz'))).toBe('u_xyz');
  });

  test('userIdFromChannel returns null for non-matching channels', () => {
    expect(userIdFromChannel('foo:bar')).toBeNull();
    expect(userIdFromChannel('rt:user:')).toBeNull();
    expect(userIdFromChannel('')).toBeNull();
  });
});

describe('RealtimeUpdatesService.broadcast', () => {
  test('routes to deliver with the userId', () => {
    const svc = new StubRealtime();
    svc.broadcast({
      entityType: 'holding',
      operationType: 'update',
      entityId: 'h1',
      userId: 'u1',
    });
    expect(svc.delivered).toHaveLength(1);
    expect(svc.delivered[0]?.userId).toBe('u1');
  });

  test('serializes the wire payload with type=entity_changed and ISO timestamp', () => {
    const svc = new StubRealtime();
    const at = new Date('2024-01-15T10:00:00.000Z');
    svc.broadcast({
      entityType: 'account',
      operationType: 'create',
      entityId: 'a1',
      userId: 'u1',
      timestamp: at,
      data: { name: 'My Bank' },
    });
    const wire = lastPayload(svc);
    expect(wire.type).toBe('entity_changed');
    expect(wire.entityType).toBe('account');
    expect(wire.operationType).toBe('create');
    expect(wire.entityId).toBe('a1');
    expect(wire.timestamp).toBe('2024-01-15T10:00:00.000Z');
    expect(wire.data).toEqual({ name: 'My Bank' });
  });

  test('injects timestamp when caller omits it', () => {
    const svc = new StubRealtime();
    const before = Date.now();
    svc.broadcast({
      entityType: 'token',
      operationType: 'update',
      userId: 'u1',
    });
    const after = Date.now();
    const wire = lastPayload(svc);
    const ts = Date.parse(wire.timestamp as string);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  test('preserves metadata and entityIds for bulk-shaped events', () => {
    const svc = new StubRealtime();
    const event: Omit<RealTimeEvent, 'timestamp'> = {
      entityType: 'holding',
      operationType: 'sync',
      entityIds: ['h1', 'h2', 'h3'],
      userId: 'u1',
      metadata: { source: 'wallet_import', extra: 42 },
    };
    svc.broadcast(event);
    const wire = lastPayload(svc);
    expect(wire.entityIds).toEqual(['h1', 'h2', 'h3']);
    expect(wire.metadata).toEqual({ source: 'wallet_import', extra: 42 });
  });
});

describe('RealtimeUpdatesService.broadcastBulk', () => {
  test('builds a single bulk event from N entityIds', () => {
    const svc = new StubRealtime();
    svc.broadcastBulk({
      entityType: 'vault',
      operationType: 'delete',
      entityIds: ['v1', 'v2'],
      userId: 'u1',
    });
    expect(svc.delivered).toHaveLength(1);
    const wire = lastPayload(svc);
    expect(wire.operationType).toBe('delete');
    expect(wire.entityIds).toEqual(['v1', 'v2']);
    expect(wire.entityId).toBeUndefined();
  });

  test('forwards metadata to deliver', () => {
    const svc = new StubRealtime();
    svc.broadcastBulk({
      entityType: 'holding',
      operationType: 'update',
      entityIds: ['h1'],
      userId: 'u1',
      metadata: { source: 'rebalance' },
    });
    const wire = lastPayload(svc);
    expect(wire.metadata).toEqual({ source: 'rebalance' });
  });
});
