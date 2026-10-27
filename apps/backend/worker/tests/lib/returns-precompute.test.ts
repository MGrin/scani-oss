import { describe, expect, test } from 'bun:test';
import type { LifecycleEvent, LifecycleMirror } from '@scani/queue';
import {
  PrecomputingLifecycleMirror,
  ReturnsPrecomputeScheduler,
} from '../../src/lib/returns-precompute';

// SC-1745: an app open starts 13 balance refreshes, and each one moves the
// user's returns data version. The worker precomputes Home's returns once
// they have settled, not once per refresh (operator bound).

const DELAY_MS = 30;

function recorder() {
  const runs: string[] = [];
  return { runs, run: async (userId: string) => void runs.push(userId) };
}

const completed = (userId: string, jobName = 'refresh-account-balance'): LifecycleEvent =>
  ({
    type: 'completed',
    jobId: `${jobName}-${Math.random()}`,
    userId,
    jobName,
    result: null,
  }) as never;

describe('ReturnsPrecomputeScheduler', () => {
  test('13 triggers inside the delay are one precompute', async () => {
    const r = recorder();
    const scheduler = new ReturnsPrecomputeScheduler(r.run, DELAY_MS);
    for (let i = 0; i < 13; i++) scheduler.schedule('user-a');
    await Bun.sleep(DELAY_MS * 3);
    await scheduler.idle();
    expect(r.runs).toEqual(['user-a']);
  });

  test('each user gets their own precompute', async () => {
    const r = recorder();
    const scheduler = new ReturnsPrecomputeScheduler(r.run, DELAY_MS);
    scheduler.schedule('user-a');
    scheduler.schedule('user-b');
    scheduler.schedule('user-a');
    await Bun.sleep(DELAY_MS * 3);
    await scheduler.idle();
    expect(r.runs.sort()).toEqual(['user-a', 'user-b']);
  });

  test('precomputes run one at a time, so the worker spends one compute at once', async () => {
    let inFlight = 0;
    let peak = 0;
    const scheduler = new ReturnsPrecomputeScheduler(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Bun.sleep(10);
      inFlight -= 1;
    }, 1);
    for (const user of ['a', 'b', 'c']) scheduler.schedule(user);
    await Bun.sleep(20);
    await scheduler.idle();
    expect(peak).toBe(1);
  });

  test('a failed precompute does not stop the next one', async () => {
    const runs: string[] = [];
    const scheduler = new ReturnsPrecomputeScheduler(async (userId) => {
      runs.push(userId);
      if (userId === 'bad') throw new Error('boom');
    }, 1);
    scheduler.schedule('bad');
    await Bun.sleep(10);
    scheduler.schedule('good');
    await Bun.sleep(10);
    await scheduler.idle();
    expect(runs).toEqual(['bad', 'good']);
  });
});

describe('PrecomputingLifecycleMirror', () => {
  function inner() {
    const events: LifecycleEvent[] = [];
    const mirror: LifecycleMirror = {
      onLifecycle: async (e) => void events.push(e),
      isCancelled: async (id) => id === 'cancelled',
    };
    return { events, mirror };
  }

  test('a completed user job is recorded first, then schedules a precompute', async () => {
    const i = inner();
    const scheduled: string[] = [];
    const mirror = new PrecomputingLifecycleMirror(i.mirror, {
      schedule: (u) => scheduled.push(u),
    });
    await mirror.onLifecycle(completed('user-a'));
    expect(i.events).toHaveLength(1);
    expect(scheduled).toEqual(['user-a']);
  });

  test('progress, failure and a deleted account schedule nothing', async () => {
    const i = inner();
    const scheduled: string[] = [];
    const mirror = new PrecomputingLifecycleMirror(i.mirror, {
      schedule: (u) => scheduled.push(u),
    });
    await mirror.onLifecycle({
      type: 'active',
      jobId: 'j',
      userId: 'u',
      jobName: 'x',
      attemptsMade: 1,
    } as never);
    await mirror.onLifecycle({
      type: 'failed',
      jobId: 'j',
      userId: 'u',
      jobName: 'x',
      error: 'e',
    } as never);
    await mirror.onLifecycle(completed('u', 'user-data-delete'));
    expect(scheduled).toEqual([]);
    expect(i.events).toHaveLength(3);
  });

  test('CONTROL: cancellation is still asked of the durable mirror', async () => {
    const i = inner();
    const mirror = new PrecomputingLifecycleMirror(i.mirror, { schedule: () => {} });
    expect(await mirror.isCancelled?.('cancelled')).toBe(true);
    expect(await mirror.isCancelled?.('other')).toBe(false);
  });
});
