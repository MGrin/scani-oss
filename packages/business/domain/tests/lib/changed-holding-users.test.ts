import { describe, expect, test } from 'bun:test';
import { type RealTimeEvent, RedisRealtimeUpdatesService } from '@scani/realtime';
import { Container } from 'typedi';
import { ChangedHoldingUsers } from '../../src/lib/changed-holding-users';
import { restoreContainerAfterAll } from '../../test/helpers/container';

/**
 * The hourly balance syncs wrote new balances and told no open app, so a
 * screen showed the old figures until a reload (SC-1600, from the SC-1598
 * liveness audit). One event per user whose holdings changed, per run.
 */

restoreContainerAfterAll();

function capture() {
  const events: Array<Omit<RealTimeEvent, 'timestamp'>> = [];
  Container.set(RedisRealtimeUpdatesService, {
    broadcast: (event: Omit<RealTimeEvent, 'timestamp'>) => {
      events.push(event);
    },
  } as unknown as RedisRealtimeUpdatesService);
  return events;
}

type SyncResult = {
  updated: number;
  created: number;
  removed: number;
  observationsWritten: number;
};
const none: SyncResult = { updated: 0, created: 0, removed: 0, observationsWritten: 0 };
/** An account's sync result as the helper returns it. */
const run = (counts: Partial<SyncResult>): SyncResult => ({ ...none, ...counts });

describe('ChangedHoldingUsers', () => {
  test('one holding sync per user whose holdings changed, however many accounts did', () => {
    const events = capture();
    const changed = new ChangedHoldingUsers();
    changed.record('user-a', run({ updated: 2, observationsWritten: 2 }));
    changed.record('user-a', run({ created: 1, observationsWritten: 1 }));
    changed.record('user-b', run({ removed: 1, observationsWritten: 1 }));
    changed.announce('wallet_balance_sync');

    expect(
      events.map(({ entityType, operationType, userId }) => ({ entityType, operationType, userId }))
    ).toEqual([
      { entityType: 'holding', operationType: 'sync', userId: 'user-a' },
      { entityType: 'holding', operationType: 'sync', userId: 'user-b' },
    ]);
    expect(events[0]?.data).toEqual({ reason: 'wallet_balance_sync' });
  });

  test('control: a user whose sync changed nothing is not told', () => {
    const events = capture();
    const changed = new ChangedHoldingUsers();
    changed.record('user-a', none);
    changed.announce('exchange_balance_sync');
    expect(events).toEqual([]);
  });

  test('an hourly wallet sync that only re-stamped an unchanged balance tells nobody', () => {
    // The wallet sync writes the cache on an unchanged balance, so `updated`
    // counts it (feeds, #22723). Only a written observation is a change.
    const events = capture();
    const changed = new ChangedHoldingUsers();
    changed.record('user-a', run({ updated: 3 }));
    changed.announce('wallet_balance_sync');
    expect(events).toEqual([]);
  });

  test('a publisher that throws is logged, not raised, and the rest are still told', () => {
    const told: string[] = [];
    Container.set(RedisRealtimeUpdatesService, {
      broadcast: (event: Omit<RealTimeEvent, 'timestamp'>) => {
        if (event.userId === 'user-a') throw new Error('redis down');
        told.push(event.userId);
      },
    } as unknown as RedisRealtimeUpdatesService);
    const changed = new ChangedHoldingUsers();
    changed.record('user-a', run({ updated: 1, observationsWritten: 1 }));
    changed.record('user-b', run({ updated: 1, observationsWritten: 1 }));
    expect(() => changed.announce('wallet_balance_sync')).not.toThrow();
    expect(told).toEqual(['user-b']);
  });
});
