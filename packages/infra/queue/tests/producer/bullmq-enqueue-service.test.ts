import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Container } from 'typedi';
import { z } from 'zod';
import type { UserJobDescriptor } from '../../src/core/job-descriptor';
import type { EnqueuedJobMeta, UserJobBase } from '../../src/core/types';
import { BullMqEnqueueService } from '../../src/producer/bullmq-enqueue-service';
import { ENQUEUE_MIRROR } from '../../src/producer/enqueue-mirror';
import { QueueClient } from '../../src/producer/queue-client';

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
    setupQueue(new Error('redis down'));
    const onEnqueueFailed = mock<
      (jobId: string, err: Error, meta: Omit<EnqueuedJobMeta, 'payloadSummary'>) => Promise<void>
    >(async () => {});
    Container.set(ENQUEUE_MIRROR, { onEnqueued: async () => {}, onEnqueueFailed });
    const svc = new BullMqEnqueueService();
    await expect(
      svc.add(TEST_DESCRIPTOR, { userId: 'u1', requestId: 'r1', resourceId: 'res-9' })
    ).rejects.toThrow('redis down');
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
