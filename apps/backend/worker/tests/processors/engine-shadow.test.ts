import { describe, expect, spyOn, test } from 'bun:test';
import type { ShadowRunSummary } from '@scani/domain/repositories';
import { restoreContainerAfterAll } from '@scani/domain/test-helpers';
import { type EngineShadowRunResult, RunEngineShadowsUseCase } from '@scani/domain/use-cases';
import type { ProcessorContext } from '@scani/queue';
import { Container } from 'typedi';
import { EngineShadowProcessor } from '../../src/processors/engine-shadow';

// Container stubs are process-global; put back whatever this file changes
// so no later test file resolves them (SC-448).
restoreContainerAfterAll();

type Input = Parameters<RunEngineShadowsUseCase['execute']>[0];
type Job = ProcessorContext['job'];

const summary = (compared: number, byCategory: Record<string, number>): ShadowRunSummary => ({
  compared,
  matched: compared - Object.values(byCategory).reduce((a, b) => a + b, 0),
  byCategory,
  durationMs: 5,
});

const RUNS: Record<'price' | 'balance', EngineShadowRunResult> = {
  price: { kind: 'price', runId: 'run-p', summary: summary(4, {}) },
  balance: { kind: 'balance', runId: 'run-b', summary: summary(10, { unexplained: 2 }) },
};

/** A use case that reports each kind it is asked for, failing those named in `fails`. */
function harness(fails: ReadonlyArray<'price' | 'balance'> = []) {
  const inputs: Input[] = [];
  Container.set(RunEngineShadowsUseCase, {
    execute: async (input: Input) => {
      inputs.push(input);
      const failures: unknown[] = [];
      for (const kind of input.kinds ?? ['price', 'balance']) {
        if (fails.includes(kind)) failures.push(new Error(`${kind} broke`));
        else await input.onRecorded?.(RUNS[kind]);
      }
      if (failures.length > 0) throw failures[0];
      return [];
    },
  } as unknown as RunEngineShadowsUseCase);
  const processor = new EngineShadowProcessor();
  // `logger` is private so the processor owns its component name.
  const { logger } = processor as unknown as {
    logger: { info: (context: unknown, message: string) => void };
  };
  return { processor, inputs, logger };
}

/** The slice of a BullMQ job the processor touches; `updateData` replaces `data`, as BullMQ's does. */
function fakeJob(data: Record<string, unknown> = {}, id = 'job-1') {
  const saved: Array<Record<string, unknown>> = [];
  const job = {
    id,
    data,
    updateData: async (next: Record<string, unknown>) => {
      saved.push(next);
      job.data = next;
    },
  };
  return { job, saved };
}

// `handle` is protected — the scheduled-job base calls it, inside the advisory
// lock, which has its own coverage.
async function handle(
  processor: EngineShadowProcessor,
  logger: { info: (context: unknown, message: string) => void },
  job: ReturnType<typeof fakeJob>['job']
): Promise<{ logged: unknown[]; error: unknown }> {
  const info = spyOn(logger, 'info').mockImplementation(() => {});
  try {
    const error = await (processor as unknown as { handle: (job: Job) => Promise<void> })
      .handle(job as unknown as Job)
      .then(
        () => undefined,
        (err: unknown) => err
      );
    return { logged: info.mock.calls.map(([context]) => context), error };
  } finally {
    info.mockRestore();
  }
}

describe('EngineShadowProcessor', () => {
  test('handle runs the use case once with a Date', async () => {
    const { processor, inputs, logger } = harness();
    const before = Date.now();
    await handle(processor, logger, fakeJob().job);
    const after = Date.now();

    expect(inputs).toHaveLength(1);
    const [input] = inputs;
    expect(input?.asOf).toBeInstanceOf(Date);
    expect(input?.asOf.getTime()).toBeGreaterThanOrEqual(before);
    expect(input?.asOf.getTime()).toBeLessThanOrEqual(after);
    // The nightly run is every user, and on a first attempt both kinds.
    expect(input?.userId).toBeUndefined();
    expect(input?.kinds).toEqual(['price', 'balance']);
  });

  test('logs one line per run: kind, run id, compared, matched and byCategory', async () => {
    const { processor, logger } = harness();

    const { logged } = await handle(processor, logger, fakeJob().job);

    expect(logged).toEqual([
      { kind: 'price', runId: 'run-p', compared: 4, matched: 4, byCategory: {} },
      { kind: 'balance', runId: 'run-b', compared: 10, matched: 8, byCategory: { unexplained: 2 } },
    ]);
  });

  test('a run that completed is logged and saved on the job when its sibling fails', async () => {
    const { processor, logger } = harness(['balance']);
    const { job, saved } = fakeJob();

    const { logged, error } = await handle(processor, logger, job);

    expect((error as Error).message).toBe('balance broke');
    expect(logged).toEqual([
      { kind: 'price', runId: 'run-p', compared: 4, matched: 4, byCategory: {} },
    ]);
    expect(saved).toEqual([{ engineShadowKindsDone: { jobId: 'job-1', kinds: ['price'] } }]);
  });

  test('a retry runs only the kinds an earlier attempt did not record', async () => {
    const { processor, inputs, logger } = harness();
    const { job, saved } = fakeJob({ engineShadowKindsDone: { jobId: 'job-1', kinds: ['price'] } });

    await handle(processor, logger, job);

    expect(inputs[0]?.kinds).toEqual(['balance']);
    expect(saved).toEqual([
      { engineShadowKindsDone: { jobId: 'job-1', kinds: ['price', 'balance'] } },
    ]);
  });

  test("another job's done list is nothing done, so a list leaking into a later night skips no kind", async () => {
    // If the list ever reached the scheduler's template, every later night's
    // job would start with it. Its job id is what tells this night from that one.
    const { processor, inputs, logger } = harness();
    const { job, saved } = fakeJob(
      { engineShadowKindsDone: { jobId: 'job-1', kinds: ['price'] } },
      'job-2'
    );

    await handle(processor, logger, job);

    expect(inputs[0]?.kinds).toEqual(['price', 'balance']);
    expect(saved.at(-1)).toEqual({
      engineShadowKindsDone: { jobId: 'job-2', kinds: ['price', 'balance'] },
    });
  });

  test('a done list it cannot read reruns both kinds rather than skipping one', async () => {
    const { processor, inputs, logger } = harness();

    const unreadable: unknown[] = [
      'price',
      ['price'],
      { jobId: 'job-1', kinds: 'price' },
      { jobId: 'job-1', kinds: ['prices', 7] },
      { kinds: ['price'] },
    ];
    for (const done of unreadable) {
      await handle(processor, logger, fakeJob({ engineShadowKindsDone: done }).job);
    }

    expect(inputs.map((i) => i.kinds)).toEqual(unreadable.map(() => ['price', 'balance']));
  });
});
