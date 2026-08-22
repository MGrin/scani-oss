import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { StoreCommandTimeoutError } from '@scani/deadline';
import { Container } from 'typedi';
import { z } from 'zod';
// This workspace cannot depend on @scani/domain (it sits below it), so the
// shared helper is reached the same way the shared test preload is: by path.
import { restoreContainerAfterAll } from '../../../../business/domain/test/helpers/container';
import type { UserJobDescriptor } from '../../src/core/job-descriptor';
import type { EnqueuedJobMeta, UserJobBase } from '../../src/core/types';
import { BullMqEnqueueService } from '../../src/producer/bullmq-enqueue-service';
import { ENQUEUE_MIRROR } from '../../src/producer/enqueue-mirror';
import { QueueClient } from '../../src/producer/queue-client';

// Container stubs are process-global; put back whatever this file changes
// so no later test file resolves them (SC-448).
restoreContainerAfterAll();

interface TestPayload extends UserJobBase {
  resourceId: string;
}

const TEST_DESCRIPTOR: UserJobDescriptor<TestPayload> = {
  name: 'test-job',
  schema: z.object({
    userId: z.string(),
    requestId: z.string(),
    resourceId: z.string(),
  }),
  defaultOpts: { attempts: 3, removeOnComplete: 100, removeOnFail: 500 },
  computeJobId: (d) => ['test-job', d.userId, d.resourceId, d.requestId].join('_'),
  summarizePayload: (d) => ({ resourceId: d.resourceId }),
};

function setupQueue(addThrows?: Error) {
  const addCalls: Array<{ name: string; data: unknown; opts: unknown }> = [];
  const fakeQueue = {
    add: mock(async (name: string, data: unknown, opts: unknown) => {
      addCalls.push({ name, data, opts });
      if (addThrows) throw addThrows;
    }),
  };
  Container.set(QueueClient, { get: () => fakeQueue } as never);
  return { addCalls, fakeQueue };
}

beforeEach(() => {
  Container.remove(QueueClient);
  Container.remove(ENQUEUE_MIRROR);
});
afterEach(() => {
  Container.remove(QueueClient);
  Container.remove(ENQUEUE_MIRROR);
});

describe('BullMqEnqueueService — happy path', () => {
  test('returns the deterministic jobId from the descriptor', async () => {
    setupQueue();
    const svc = new BullMqEnqueueService();
    const jobId = await svc.add(TEST_DESCRIPTOR, {
      userId: 'u1',
      requestId: 'r1',
      resourceId: 'res-9',
    });
    expect(jobId).toBe('test-job_u1_res-9_r1');
  });

  test('forwards data + computed jobId to BullMQ', async () => {
    const { addCalls } = setupQueue();
    const svc = new BullMqEnqueueService();
    await svc.add(TEST_DESCRIPTOR, { userId: 'u1', requestId: 'r1', resourceId: 'res-9' });
    expect(addCalls[0]?.name).toBe('test-job');
    expect(addCalls[0]?.data).toEqual({ userId: 'u1', requestId: 'r1', resourceId: 'res-9' });
    expect((addCalls[0]?.opts as { jobId: string }).jobId).toBe('test-job_u1_res-9_r1');
  });

  test('overrides take precedence over descriptor.defaultOpts', async () => {
    const { addCalls } = setupQueue();
    const svc = new BullMqEnqueueService();
    await svc.add(
      TEST_DESCRIPTOR,
      { userId: 'u1', requestId: 'r1', resourceId: 'res-9' },
      { attempts: 99 }
    );
    expect((addCalls[0]?.opts as { attempts: number }).attempts).toBe(99);
  });
});

describe('BullMqEnqueueService — mirror integration', () => {
  test('calls onEnqueued before queue.add with the summarized payload', async () => {
    setupQueue();
    const onEnqueued = mock<(meta: EnqueuedJobMeta) => Promise<void>>(async () => {});
    Container.set(ENQUEUE_MIRROR, { onEnqueued, onEnqueueFailed: async () => {} });
    const svc = new BullMqEnqueueService();
    await svc.add(TEST_DESCRIPTOR, { userId: 'u1', requestId: 'r1', resourceId: 'res-9' });
    expect(onEnqueued).toHaveBeenCalledTimes(1);
    expect(onEnqueued.mock.calls[0]?.[0]).toEqual({
      jobId: 'test-job_u1_res-9_r1',
      userId: 'u1',
      jobName: 'test-job',
      payloadSummary: { resourceId: 'res-9' },
      attemptsAllowed: 3,
    });
  });

  test('calls onEnqueueFailed when queue.add throws', async () => {
    setupQueue(new Error('queue store down'));
    const onEnqueueFailed = mock<
      (jobId: string, err: Error, meta: Omit<EnqueuedJobMeta, 'payloadSummary'>) => Promise<void>
    >(async () => {});
    Container.set(ENQUEUE_MIRROR, { onEnqueued: async () => {}, onEnqueueFailed });
    const svc = new BullMqEnqueueService();
    await expect(
      svc.add(TEST_DESCRIPTOR, { userId: 'u1', requestId: 'r1', resourceId: 'res-9' })
    ).rejects.toThrow('queue store down');
    expect(onEnqueueFailed).toHaveBeenCalledTimes(1);
  });

  test('works without a mirror registered (Tier-1 OSS path)', async () => {
    setupQueue();
    const svc = new BullMqEnqueueService();
    await expect(
      svc.add(TEST_DESCRIPTOR, { userId: 'u1', requestId: 'r1', resourceId: 'res-9' })
    ).resolves.toBe('test-job_u1_res-9_r1');
  });
});

describe('BullMqEnqueueService — an unreachable queue store (SC-523)', () => {
  // A `queue.add` that neither resolves nor rejects is what an unreachable
  // queue store actually produces. Since SC-518 that store is Postgres, and
  // BullMQ's Postgres backend leaves three waits unbounded: no
  // `connectionTimeoutMillis` on the pool, no `statement_timeout` on it, and
  // an OS-length wait on a black-holed socket. Measured 2026-08-22 through
  // this class against `bullmq.job` held under `ACCESS EXCLUSIVE`: still
  // unsettled at 30s, resolving at 30684ms when the lock was released.
  function setupHangingQueue() {
    const fakeQueue = { add: mock(() => new Promise<void>(() => {})) };
    Container.set(QueueClient, { get: () => fakeQueue } as never);
    return fakeQueue;
  }

  test('THE DEFECT: add rejects instead of hanging when queue.add never settles', async () => {
    setupHangingQueue();
    const svc = new BullMqEnqueueService();
    const started = Date.now();
    await expect(
      svc.add(TEST_DESCRIPTOR, { userId: 'u1', requestId: 'r1', resourceId: 'res-9' })
      // The exact string, because it is what an operator reads during an
      // incident and the store it names is what they go and look at. It said
      // `redis` for a `pg` query between SC-518 and SC-578 (SC-578).
    ).rejects.toThrow('postgres enqueue timed out after 10000ms');
    // The bound is the point, so assert it bounded something: a pass that took
    // the suite's 30s timeout would be the defect, not the fix. The ceiling is
    // above ENQUEUE_TIMEOUT_MS (10s) rather than equal to it — this asserts
    // that a bound fired, not what its value is, and pinning it to the
    // constant would make the test fail on a slow box for no defect.
    expect(Date.now() - started).toBeLessThan(20_000);
  });

  // Uses a queue that REJECTS rather than one that hangs, so it does not pay
  // the real ENQUEUE_TIMEOUT_MS a second time — what it asserts is the
  // fail-closed wiring downstream of a rejection, not that the bound fires.
  // That the bound itself fires, and with which message, is the test above;
  // deleting that one leaves this path covered only from the rejection
  // onwards.
  test('fails CLOSED: the mirror row is marked failed, so no job is silently lost', async () => {
    setupQueue(new StoreCommandTimeoutError('postgres', 'enqueue', 10_000));
    const onEnqueueFailed = mock<
      (jobId: string, err: Error, meta: Omit<EnqueuedJobMeta, 'payloadSummary'>) => Promise<void>
    >(async () => {});
    Container.set(ENQUEUE_MIRROR, { onEnqueued: async () => {}, onEnqueueFailed });
    const svc = new BullMqEnqueueService();
    await expect(
      svc.add(TEST_DESCRIPTOR, { userId: 'u1', requestId: 'r1', resourceId: 'res-9' })
    ).rejects.toBeInstanceOf(Error);
    expect(onEnqueueFailed).toHaveBeenCalledTimes(1);
    expect(onEnqueueFailed.mock.calls[0]?.[0]).toBe('test-job_u1_res-9_r1');
    expect(onEnqueueFailed.mock.calls[0]?.[1].message).toContain('timed out');
  });

  // ---------------------------------------------------------------------
  // The two below look deletable — they assert the ordinary thing still
  // happens — and they are the reason this fix is not worse than the bug.
  //
  // A timeout is a discriminator, and the benign case that shares its signal
  // is a store that is ALIVE and merely SLOW: a loaded box, a Fly host under
  // pressure, a Lua script behind a big pipeline. A bound that fires there
  // turns every import into a false "we couldn't start that" during exactly
  // the load spike the queue exists to absorb — strictly worse than the
  // spinner it replaced, and it would still pass every "it no longer hangs"
  // test above. Argue with that reason before deleting the assertion.
  // ---------------------------------------------------------------------
  test('CONTROL: a healthy queue still enqueues, bound or no bound', async () => {
    setupQueue();
    const svc = new BullMqEnqueueService();
    await expect(
      svc.add(TEST_DESCRIPTOR, { userId: 'u1', requestId: 'r1', resourceId: 'res-9' })
    ).resolves.toBe('test-job_u1_res-9_r1');
  });

  test('CONTROL: a slow-but-alive queue.add is still an enqueue, not a failure', async () => {
    const fakeQueue = {
      add: mock(async () => {
        await Bun.sleep(300);
      }),
    };
    Container.set(QueueClient, { get: () => fakeQueue } as never);
    const onEnqueueFailed = mock(async () => {});
    Container.set(ENQUEUE_MIRROR, { onEnqueued: async () => {}, onEnqueueFailed });
    const svc = new BullMqEnqueueService();
    await expect(
      svc.add(TEST_DESCRIPTOR, { userId: 'u1', requestId: 'r1', resourceId: 'res-9' })
    ).resolves.toBe('test-job_u1_res-9_r1');
    expect(onEnqueueFailed).not.toHaveBeenCalled();
  });
});
