import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Container } from 'typedi';
import type { ScheduledJobDescriptor } from '../../src/core/job-descriptor';
import { JobScheduler } from '../../src/producer/job-scheduler';
import { QueueClient } from '../../src/producer/queue-client';

interface FakeScheduler {
  key: string;
  pattern?: string;
}

function stubQueue(initialSchedulers: FakeScheduler[] = []) {
  const upsertCalls: Array<{ key: string; pattern: { pattern: string }; opts: unknown }> = [];
  const removeCalls: string[] = [];
  const list: FakeScheduler[] = [...initialSchedulers];
  return {
    upsertCalls,
    removeCalls,
    queue: {
      upsertJobScheduler: mock(async (key: string, pattern: { pattern: string }, opts: unknown) => {
        upsertCalls.push({ key, pattern, opts });
        if (!list.find((s) => s.key === key)) {
          list.push({ key, pattern: pattern.pattern });
        }
      }),
      // Snapshot the list — the JobScheduler iterates this while
      // calling removeJobScheduler, and BullMQ's real getJobSchedulers
      // doesn't return a live mutable reference.
      getJobSchedulers: mock(async () => [...list]),
      removeJobScheduler: mock(async (key: string) => {
        removeCalls.push(key);
        const idx = list.findIndex((s) => s.key === key);
        if (idx >= 0) list.splice(idx, 1);
      }),
    },
  };
}

beforeEach(() => {
  Container.remove(QueueClient);
});
afterEach(() => {
  Container.remove(QueueClient);
});

describe('JobScheduler — upsertAll', () => {
  test('upserts every wanted descriptor with scheduler:<name> key', async () => {
    const { queue, upsertCalls } = stubQueue();
    Container.set(QueueClient, { get: () => queue } as never);
    const descriptors: ScheduledJobDescriptor[] = [
      { name: 'pricing', cron: '0 * * * *' },
      { name: 'apy-payouts', cron: '0 0 * * *' },
    ];
    await new JobScheduler().upsertAll(descriptors);
    expect(upsertCalls.map((c) => c.key)).toEqual(['scheduler:pricing', 'scheduler:apy-payouts']);
  });

  test('reconciles orphans: deletes scheduler:<name> entries not in the wanted list', async () => {
    const { queue, removeCalls } = stubQueue([
      { key: 'scheduler:pricing' },
      { key: 'scheduler:removed-job' }, // orphan — was removed from source
      { key: 'scheduler:another-orphan' },
    ]);
    Container.set(QueueClient, { get: () => queue } as never);
    const descriptors: ScheduledJobDescriptor[] = [{ name: 'pricing', cron: '0 * * * *' }];
    await new JobScheduler().upsertAll(descriptors);
    expect(removeCalls.sort()).toEqual(['scheduler:another-orphan', 'scheduler:removed-job']);
  });

  test('does not delete unrelated keys (only those with scheduler: prefix)', async () => {
    const { queue, removeCalls } = stubQueue([
      { key: 'scheduler:pricing' },
      { key: 'unrelated-key' },
      { key: 'manual:something' },
    ]);
    Container.set(QueueClient, { get: () => queue } as never);
    const descriptors: ScheduledJobDescriptor[] = [{ name: 'pricing', cron: '0 * * * *' }];
    await new JobScheduler().upsertAll(descriptors);
    expect(removeCalls).toEqual([]);
  });

  test('honors timezone override', async () => {
    const { queue, upsertCalls } = stubQueue();
    Container.set(QueueClient, { get: () => queue } as never);
    await new JobScheduler().upsertAll([
      { name: 'tz-test', cron: '0 9 * * *', timezone: 'America/New_York' },
    ]);
    expect((upsertCalls[0]?.pattern as { pattern: string; tz?: string }).tz).toBe(
      'America/New_York'
    );
  });

  test('defaults timezone to UTC when descriptor omits it', async () => {
    const { queue, upsertCalls } = stubQueue();
    Container.set(QueueClient, { get: () => queue } as never);
    await new JobScheduler().upsertAll([{ name: 'utc-default', cron: '0 0 * * *' }]);
    expect((upsertCalls[0]?.pattern as { pattern: string; tz?: string }).tz).toBe('UTC');
  });
});
