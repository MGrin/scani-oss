import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Container } from 'typedi';
import type { ScheduledJobDescriptor } from '../../src/core/job-descriptor';
import { JobScheduler } from '../../src/producer/job-scheduler';
import { QueueClient } from '../../src/producer/queue-client';

interface FakeScheduler {
  key: string;
  pattern?: string;
  next?: number;
}

function stubQueue(initialSchedulers: FakeScheduler[] = []) {
  const upsertCalls: Array<{ key: string; pattern: { pattern: string }; opts: unknown }> = [];
  const removeCalls: string[] = [];
  const addCalls: Array<{ name: string; data: unknown; opts: { jobId?: string } }> = [];
  const list: FakeScheduler[] = [...initialSchedulers];
  return {
    upsertCalls,
    removeCalls,
    addCalls,
    queue: {
      add: mock(async (name: string, data: unknown, opts: { jobId?: string }) => {
        addCalls.push({ name, data, opts });
      }),
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

  test('repeatable jobs are enqueued with attempts and backoff so transient DB drops do not dead-letter', async () => {
    const { queue, upsertCalls } = stubQueue();
    Container.set(QueueClient, { get: () => queue } as never);
    await new JobScheduler().upsertAll([{ name: 'retry-test', cron: '0 * * * *' }]);
    const opts = (upsertCalls[0]?.opts as { opts?: { attempts?: number; backoff?: unknown } })
      ?.opts;
    expect(opts?.attempts).toBeGreaterThanOrEqual(3);
    expect(opts?.backoff).toBeDefined();
  });
});

// Regression: SC-49. `upsertJobScheduler` deletes whatever occurrence is
// currently armed and re-arms from `now`, so a run that came due while no
// worker was alive is destroyed on the next boot — silently, with no error
// and no heartbeat. Six weeks of nightly `historical-price-backfill` pages
// came from deploys landing on its 03:00 cron minute.
describe('JobScheduler — replaying occurrences lost to the re-arm', () => {
  test('replays an occurrence that was already due when upsertAll ran', async () => {
    const dueAt = Date.now() - 60_000;
    const { queue, addCalls } = stubQueue([
      { key: 'scheduler:historical-price-backfill', next: dueAt },
    ]);
    Container.set(QueueClient, { get: () => queue } as never);
    await new JobScheduler().upsertAll([{ name: 'historical-price-backfill', cron: '0 3 * * *' }]);
    expect(addCalls).toHaveLength(1);
    expect(addCalls[0]?.name).toBe('historical-price-backfill');
  });

  test('the replay job id is deterministic and colon-free so simultaneous boots dedupe', async () => {
    const dueAt = 1_786_590_000_000;
    const { queue, addCalls } = stubQueue([{ key: 'scheduler:pricing', next: dueAt }]);
    Container.set(QueueClient, { get: () => queue } as never);
    await new JobScheduler().upsertAll([{ name: 'pricing', cron: '0 * * * *' }]);
    const jobId = addCalls[0]?.opts.jobId;
    expect(jobId).toBe(`catchup-pricing-${dueAt}`);
    // BullMQ rejects custom job ids containing a colon.
    expect(jobId).not.toContain(':');
  });

  test('does not replay an occurrence still in the future', async () => {
    const { queue, addCalls } = stubQueue([
      { key: 'scheduler:pricing', next: Date.now() + 60 * 60_000 },
    ]);
    Container.set(QueueClient, { get: () => queue } as never);
    await new JobScheduler().upsertAll([{ name: 'pricing', cron: '0 * * * *' }]);
    expect(addCalls).toEqual([]);
  });

  test('does not replay for a scheduler being registered for the first time', async () => {
    const { queue, addCalls } = stubQueue();
    Container.set(QueueClient, { get: () => queue } as never);
    await new JobScheduler().upsertAll([{ name: 'brand-new', cron: '0 3 * * *' }]);
    expect(addCalls).toEqual([]);
  });

  test('does not replay for an orphan scheduler that is being removed', async () => {
    const { queue, addCalls, removeCalls } = stubQueue([
      { key: 'scheduler:removed-job', next: Date.now() - 60_000 },
    ]);
    Container.set(QueueClient, { get: () => queue } as never);
    await new JobScheduler().upsertAll([{ name: 'pricing', cron: '0 * * * *' }]);
    expect(removeCalls).toEqual(['scheduler:removed-job']);
    expect(addCalls).toEqual([]);
  });

  test('a replay that fails does not abort registration of the remaining schedules', async () => {
    const { queue, addCalls, upsertCalls } = stubQueue([
      { key: 'scheduler:pricing', next: Date.now() - 60_000 },
    ]);
    queue.add = mock(async () => {
      throw new Error('redis blip');
    }) as never;
    Container.set(QueueClient, { get: () => queue } as never);
    await new JobScheduler().upsertAll([
      { name: 'pricing', cron: '0 * * * *' },
      { name: 'apy-payouts', cron: '0 0 * * *' },
    ]);
    expect(upsertCalls.map((c) => c.key)).toEqual(['scheduler:pricing', 'scheduler:apy-payouts']);
    expect(addCalls).toEqual([]);
  });
});
