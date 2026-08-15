import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Container } from 'typedi';
import { z } from 'zod';
import { LIFECYCLE_MIRROR } from '../../src/consumer/lifecycle-mirror';
import { UserJobProcessor } from '../../src/consumer/user-job-processor';
import type { UserJobDescriptor } from '../../src/core/job-descriptor';
import { DURABLE_RESULT_MAX_BYTES, readTruncationNotice } from '../../src/core/result-truncator';
import type { LifecycleEvent, ProcessorContext, UserJobBase } from '../../src/core/types';
import { RedisLifecyclePublisher } from '../../src/lifecycle/redis-lifecycle-publisher';

interface TestPayload extends UserJobBase {
  value: string;
}

const TEST_DESCRIPTOR: UserJobDescriptor<TestPayload, { handled: string }> = {
  name: 'test-job',
  schema: z.object({
    userId: z.string().min(1),
    requestId: z.string().min(1),
    value: z.string().min(1),
  }),
  defaultOpts: { attempts: 3, removeOnComplete: 100, removeOnFail: 500 },
  computeJobId: (d) => ['test-job', d.userId, d.requestId].join('_'),
  summarizePayload: (d) => ({ value: d.value }),
};

class StubProcessor extends UserJobProcessor<TestPayload, { handled: string }> {
  readonly descriptor = TEST_DESCRIPTOR;
  public handler: (data: TestPayload, ctx: ProcessorContext) => Promise<{ handled: string }>;
  constructor(handler: (data: TestPayload, ctx: ProcessorContext) => Promise<{ handled: string }>) {
    super();
    this.handler = handler;
  }
  protected async handle(data: TestPayload, ctx: ProcessorContext): Promise<{ handled: string }> {
    return await this.handler(data, ctx);
  }
}

function makeJob(data: unknown, jobId = 'job-1', attemptsMade = 0, attempts = 3) {
  return {
    id: jobId,
    data,
    attemptsMade,
    opts: { attempts },
    updateProgress: mock(() => Promise.resolve()),
  } as never;
}

let publisherCalls: Array<{ userId: string; jobId: string; payload: unknown }> = [];
let mirrorEvents: LifecycleEvent[] = [];

beforeEach(() => {
  publisherCalls = [];
  mirrorEvents = [];
  const stubPublisher = {
    publish: async (userId: string, jobId: string, payload: unknown) => {
      publisherCalls.push({ userId, jobId, payload });
    },
  };
  Container.set(RedisLifecyclePublisher, stubPublisher);
  Container.set(LIFECYCLE_MIRROR, {
    onLifecycle: async (event: LifecycleEvent) => {
      mirrorEvents.push(event);
    },
  });
});
afterEach(() => {
  Container.set(RedisLifecyclePublisher, new RedisLifecyclePublisher());
});

describe('UserJobProcessor — orchestration', () => {
  test('emits active → completed lifecycle on happy path', async () => {
    const proc = new StubProcessor(async () => ({ handled: 'ok' }));
    const result = await proc.process(makeJob({ userId: 'u1', requestId: 'r1', value: 'v' }));
    expect(result).toEqual({ handled: 'ok' });
    const types = mirrorEvents.map((e) => e.type);
    expect(types).toEqual(['active', 'completed']);
    const states = publisherCalls.map((c) => (c.payload as { state: string }).state);
    expect(states).toEqual(['active', 'completed']);
  });

  test('emits active → failed lifecycle on handler throw', async () => {
    const proc = new StubProcessor(async () => {
      throw new Error('boom');
    });
    await expect(
      proc.process(makeJob({ userId: 'u1', requestId: 'r1', value: 'v' }))
    ).rejects.toThrow('boom');
    const types = mirrorEvents.map((e) => e.type);
    expect(types).toEqual(['active', 'failed']);
  });

  test('throws on invalid payload before any lifecycle event fires', async () => {
    const proc = new StubProcessor(async () => ({ handled: 'ok' }));
    await expect(
      proc.process(makeJob({ userId: 'u1', requestId: 'r1' /* missing value */ }))
    ).rejects.toThrow(/Invalid payload/);
    expect(mirrorEvents).toHaveLength(0);
    expect(publisherCalls).toHaveLength(0);
  });

  test('progress callback emits a progress event + publishes', async () => {
    const proc = new StubProcessor(async (_d, ctx) => {
      await ctx.reportProgress(0.5);
      return { handled: 'ok' };
    });
    await proc.process(makeJob({ userId: 'u1', requestId: 'r1', value: 'v' }));
    const types = mirrorEvents.map((e) => e.type);
    expect(types).toEqual(['active', 'progress', 'completed']);
    const progressEvent = mirrorEvents[1] as Extract<LifecycleEvent, { type: 'progress' }>;
    expect(progressEvent.progress).toBe(0.5);
  });

  test('reportStatus emits a progress event with statusMessage + publishes', async () => {
    const proc = new StubProcessor(async (_d, ctx) => {
      await ctx.reportStatus('Waiting for IBKR — attempt 3/24');
      return { handled: 'ok' };
    });
    await proc.process(makeJob({ userId: 'u1', requestId: 'r1', value: 'v' }));
    const types = mirrorEvents.map((e) => e.type);
    expect(types).toEqual(['active', 'progress', 'completed']);
    const progressEvent = mirrorEvents[1] as Extract<LifecycleEvent, { type: 'progress' }>;
    expect(progressEvent.statusMessage).toBe('Waiting for IBKR — attempt 3/24');
    const wsPayload = publisherCalls[1]?.payload as {
      state: string;
      statusMessage?: string;
    };
    expect(wsPayload.state).toBe('progress');
    expect(wsPayload.statusMessage).toBe('Waiting for IBKR — attempt 3/24');
  });

  test('re-throws errors WITHOUT wrapping (preserves UnrecoverableError instanceof)', async () => {
    class CustomError extends Error {}
    const customErr = new CustomError('classified');
    const proc = new StubProcessor(async () => {
      throw customErr;
    });
    let caught: unknown;
    try {
      await proc.process(makeJob({ userId: 'u1', requestId: 'r1', value: 'v' }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(customErr);
    expect(caught).toBeInstanceOf(CustomError);
  });

  // The durable row keeps the payload the review UI has to read back;
  // only the WS copy is capped (SC-145).
  test('keeps a large handler result on the durable event and caps the wire copy', async () => {
    const huge = 'x'.repeat(64 * 1024);
    const proc = new StubProcessor(async () => ({ handled: huge }));
    await proc.process(makeJob({ userId: 'u1', requestId: 'r1', value: 'v' }));

    const completedEvent = mirrorEvents.find((e) => e.type === 'completed') as Extract<
      LifecycleEvent,
      { type: 'completed' }
    >;
    expect((completedEvent.result as Record<string, unknown>).handled).toBe(huge);

    const published = publisherCalls.at(-1)?.payload as Record<string, unknown>;
    const wire = published.result as Record<string, unknown>;
    expect('handled' in wire).toBe(false);
    expect(readTruncationNotice(wire)?.omittedFields).toEqual(['handled']);
  });

  test('drops a result past the durable cap without changing its field type', async () => {
    const proc = new StubProcessor(async () => ({
      handled: 'x'.repeat(DURABLE_RESULT_MAX_BYTES + 1024),
    }));
    await proc.process(makeJob({ userId: 'u1', requestId: 'r1', value: 'v' }));
    const completedEvent = mirrorEvents.find((e) => e.type === 'completed') as Extract<
      LifecycleEvent,
      { type: 'completed' }
    >;
    const durable = completedEvent.result as Record<string, unknown>;
    expect(durable.handled).toBeUndefined();
    expect(readTruncationNotice(durable)?.omittedFields).toEqual(['handled']);
  });

  /**
   * SC-155. The durable notice is what the new warn log gates on, so the two
   * cases have to be distinguishable — and this is the assertion that keeps
   * the alarm worth having.
   *
   * The WIRE copy is trimmed on almost every wallet import by design; the
   * DURABLE copy being trimmed means a user cannot import something. If a
   * wire-only trim also left a notice on the durable result, the log would
   * fire constantly, and a warning that fires constantly is one nobody reads
   * by the time the real case arrives.
   */
  test('a wire-only trim leaves no notice on the durable result (SC-155)', async () => {
    const proc = new StubProcessor(async () => ({ handled: 'x'.repeat(64 * 1024) }));
    await proc.process(makeJob({ userId: 'u1', requestId: 'r1', value: 'v' }));

    const completedEvent = mirrorEvents.find((e) => e.type === 'completed') as Extract<
      LifecycleEvent,
      { type: 'completed' }
    >;
    expect(readTruncationNotice(completedEvent.result)).toBeNull();

    // …while the wire copy carries one, which is the pair that makes the two
    // budgets separately observable.
    const wire = (publisherCalls.at(-1)?.payload as Record<string, unknown>).result;
    expect(readTruncationNotice(wire)).not.toBeNull();
  });

  test('honors descriptor.sanitizeResult override', async () => {
    const overrideDescriptor: UserJobDescriptor<TestPayload, { handled: string }> = {
      ...TEST_DESCRIPTOR,
      sanitizeResult: (r) => ({ stripped: r.handled.length }),
    };
    class Proc extends UserJobProcessor<TestPayload, { handled: string }> {
      readonly descriptor = overrideDescriptor;
      protected async handle(): Promise<{ handled: string }> {
        return { handled: 'abcdef' };
      }
    }
    await new Proc().process(makeJob({ userId: 'u1', requestId: 'r1', value: 'v' }));
    const completed = mirrorEvents[1] as Extract<LifecycleEvent, { type: 'completed' }>;
    expect(completed.result).toEqual({ stripped: 6 });
  });

  test('mirror failures do not break the job', async () => {
    Container.set(LIFECYCLE_MIRROR, {
      onLifecycle: async () => {
        throw new Error('mirror down');
      },
    });
    const proc = new StubProcessor(async () => ({ handled: 'ok' }));
    await expect(
      proc.process(makeJob({ userId: 'u1', requestId: 'r1', value: 'v' }))
    ).resolves.toEqual({ handled: 'ok' });
  });
});
