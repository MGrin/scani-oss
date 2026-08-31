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

interface FakeJob {
  id: string;
  data: { requestId?: string };
  finishedOn?: number;
  remove: () => Promise<void>;
}

interface SeedRow {
  id: string;
  requestId: string;
  /** A `completed`/`failed` row retained by `removeOnComplete` / `removeOnFail`. */
  finished: boolean;
}

interface SetupOpts {
  addThrows?: Error;
  /** Rows already in `bullmq.job` when this enqueue runs. */
  seed?: SeedRow[];
  /** Model a `remove()` that does not take, to exercise the post-condition. */
  removeIsNoop?: boolean;
}

/**
 * A queue that models `add_job`'s `ON CONFLICT (queue, id) DO NOTHING`.
 *
 * A fake whose `add` always "succeeds" cannot express SC-846 at all: the
 * defect is that the insert is skipped and the caller is told it landed. So
 * this keeps a row store and drops an add whose id is taken, exactly as
 * `bullmq/postgres/migrations/0002_functions.sql` does.
 */
function setupQueue(opts: SetupOpts | Error = {}) {
  const { addThrows, seed, removeIsNoop }: SetupOpts =
    opts instanceof Error ? { addThrows: opts } : opts;
  const store = new Map<string, FakeJob>();
  const remover = (id: string) => async () => {
    if (!removeIsNoop) store.delete(id);
  };
  for (const row of seed ?? []) {
    store.set(row.id, {
      id: row.id,
      data: { requestId: row.requestId },
      finishedOn: row.finished ? Date.now() - 60_000 : undefined,
      remove: remover(row.id),
    });
  }
  const addCalls: Array<{ name: string; data: unknown; opts: unknown }> = [];
  const fakeQueue = {
    add: mock(async (name: string, data: unknown, addOpts: unknown) => {
      addCalls.push({ name, data, opts: addOpts });
      if (addThrows) throw addThrows;
      const id = (addOpts as { jobId: string }).jobId;
      if (store.has(id)) return; // ON CONFLICT (queue, id) DO NOTHING
      store.set(id, { id, data: data as { requestId?: string }, remove: remover(id) });
    }),
    getJob: mock(async (id: string) => store.get(id)),
  };
  Container.set(QueueClient, { get: () => fakeQueue } as never);
  return { addCalls, fakeQueue, store };
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
    const fakeQueue = {
      add: mock(() => new Promise<void>(() => {})),
      getJob: mock(async () => undefined),
    };
    Container.set(QueueClient, { get: () => fakeQueue } as never);
    return fakeQueue;
  }

  // The fake above hangs `add` and resolves `getJob` INSTANTLY, so it can only
  // ever see a bound on the middle of the three store calls this enqueue now
  // makes. SC-846 added the other two — `evictFinishedNamesake` before the
  // add, `assertWorkWasQueued` after it — and an unreachable store does not
  // choose which one it fails to answer. The one that runs FIRST is the one
  // that decides whether the deadline is ever reached.
  //
  // Reproduced 2026-08-31 before this was bounded: `add()` still pending at
  // 15003ms, with the fake's `queue.add` resolving immediately — so the hang
  // was unambiguously the `getJob`, not the call the older test covers.
  test('THE DEFECT: add rejects when the FIRST store call — getJob — never settles', async () => {
    const fakeQueue = {
      // Resolves immediately: this is the control. If the bound is only on
      // `add`, nothing here is slow enough to trip it and the test can only
      // fail because of the unbounded probe around it.
      add: mock(async () => {}),
      getJob: mock(() => new Promise<undefined>(() => {})),
    };
    Container.set(QueueClient, { get: () => fakeQueue } as never);
    const svc = new BullMqEnqueueService();
    await expect(
      svc.add(TEST_DESCRIPTOR, { userId: 'u1', requestId: 'r1', resourceId: 'res-9' })
    ).rejects.toThrow('postgres enqueue timed out after 10000ms');
  }, 30_000);

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
      getJob: mock(async () => undefined),
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

describe('BullMqEnqueueService — a finished job squatting on a deterministic id (SC-846)', () => {
  // `REFRESH_ACCOUNT_BALANCE`'s shape: `requestId` is deliberately left OUT of
  // the id so a second click collapses onto the in-flight refresh. That intent
  // is correct and is preserved below. What was wrong is that `ON CONFLICT
  // (queue, id) DO NOTHING` has no notion of job STATE, so the collapse also
  // lands on a job that finished days ago — and `removeOnComplete` /
  // `removeOnFail` guarantee one is retained to land on.
  const COLLAPSING: UserJobDescriptor<TestPayload> = {
    ...TEST_DESCRIPTOR,
    name: 'collapsing-job',
    computeJobId: (d) => ['collapsing-job', d.userId, d.resourceId].join('_'),
  };
  const JOB_ID = 'collapsing-job_u1_res-9';

  // Measured on production 2026-08-29 (SC-846): the row occupying the wedged
  // account's id was `completed`, not `failed`. `removeOnComplete: 50` retains
  // it exactly as `removeOnFail: 200` would, so the FIRST SUCCESSFUL sync
  // wedges the button just as thoroughly as a failure does. A test written
  // only against `failed` would have passed over the state prod was actually in.
  test('THE DEFECT: a COMPLETED namesake no longer swallows the enqueue', async () => {
    const { store } = setupQueue({
      seed: [{ id: JOB_ID, requestId: 'old-click', finished: true }],
    });
    const svc = new BullMqEnqueueService();
    await expect(
      svc.add(COLLAPSING, { userId: 'u1', requestId: 'new-click', resourceId: 'res-9' })
    ).resolves.toBe(JOB_ID);
    // The assertion that matters is not "it resolved" — it always did. It is
    // that live work now exists under that id.
    expect(store.get(JOB_ID)?.data.requestId).toBe('new-click');
    expect(store.get(JOB_ID)?.finishedOn).toBeUndefined();
  });

  test('CONTROL: an IN-FLIGHT namesake still collapses — the dedup intent is preserved', async () => {
    const { store, addCalls } = setupQueue({
      seed: [{ id: JOB_ID, requestId: 'first-click', finished: false }],
    });
    const svc = new BullMqEnqueueService();
    await expect(
      svc.add(COLLAPSING, { userId: 'u1', requestId: 'second-click', resourceId: 'res-9' })
    ).resolves.toBe(JOB_ID);
    // Still ONE job, still the first click's. Two rapid clicks must not become
    // two refreshes — that is what the descriptor omits `requestId` for.
    expect(addCalls).toHaveLength(1);
    expect(store.get(JOB_ID)?.data.requestId).toBe('first-click');
  });

  // The other half of SC-846, and the half the reporter actually experienced:
  // the API returned a jobId and the UI showed success while nothing had been
  // queued. Eviction is what fixes the wedge; this is what makes the silent
  // no-op impossible to reintroduce — including for a descriptor written later
  // whose id nobody thought about.
  test('THE OTHER HALF: an enqueue that queued no work REJECTS instead of reporting success', async () => {
    setupQueue({
      seed: [{ id: JOB_ID, requestId: 'old-click', finished: true }],
      removeIsNoop: true,
    });
    const svc = new BullMqEnqueueService();
    await expect(
      svc.add(COLLAPSING, { userId: 'u1', requestId: 'new-click', resourceId: 'res-9' })
    ).rejects.toThrow(/no work was queued/i);
  });

  test('fails CLOSED: the mirror row is marked failed when nothing was queued', async () => {
    setupQueue({
      seed: [{ id: JOB_ID, requestId: 'old-click', finished: true }],
      removeIsNoop: true,
    });
    const onEnqueueFailed = mock<
      (jobId: string, err: Error, meta: Omit<EnqueuedJobMeta, 'payloadSummary'>) => Promise<void>
    >(async () => {});
    Container.set(ENQUEUE_MIRROR, { onEnqueued: async () => {}, onEnqueueFailed });
    const svc = new BullMqEnqueueService();
    await expect(
      svc.add(COLLAPSING, { userId: 'u1', requestId: 'new-click', resourceId: 'res-9' })
    ).rejects.toBeInstanceOf(Error);
    expect(onEnqueueFailed).toHaveBeenCalledTimes(1);
    expect(onEnqueueFailed.mock.calls[0]?.[0]).toBe(JOB_ID);
  });

  // A job that finishes between our own `add` and the check must NOT read as a
  // collapse — it is our work, done fast. The discriminator is whose
  // `requestId` the landed row carries, not whether it is finished.
  test('CONTROL: our OWN job finishing instantly is a success, not a collapse', async () => {
    const { store } = setupQueue();
    const svc = new BullMqEnqueueService();
    const inner = Container.get(QueueClient).get() as unknown as {
      add: (n: string, d: unknown, o: unknown) => Promise<void>;
    };
    const original = inner.add.bind(inner);
    inner.add = async (n, d, o) => {
      await original(n, d, o);
      const landed = store.get((o as { jobId: string }).jobId);
      if (landed) landed.finishedOn = Date.now();
    };
    await expect(
      svc.add(COLLAPSING, { userId: 'u1', requestId: 'mine', resourceId: 'res-9' })
    ).resolves.toBe(JOB_ID);
  });
});
