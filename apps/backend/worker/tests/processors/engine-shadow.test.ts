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

type Kind = EngineShadowRunResult['kind'];

const RUNS: Record<Kind, EngineShadowRunResult> = {
  balance: { kind: 'balance', runId: 'run-b', summary: summary(10, { unexplained: 2 }) },
  value: { kind: 'value', runId: 'run-v', summary: summary(4, { 'price-moved-since': 1 }) },
};
const EVERY_KIND: Kind[] = ['balance', 'value'];

/** A use case that reports each kind it is asked for, failing those named in `fails`. */
function harness(fails: ReadonlyArray<Kind> = []) {
  const inputs: Input[] = [];
  Container.set(RunEngineShadowsUseCase, {
    execute: async (input: Input) => {
      inputs.push(input);
      for (const kind of input.kinds ?? EVERY_KIND) {
        if (fails.includes(kind)) throw new Error(`${kind} broke`);
        await input.onRecorded?.(RUNS[kind]);
      }
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
    // The nightly run is every user, and on a first attempt every kind.
    expect(input?.userId).toBeUndefined();
    expect(input?.kinds).toEqual(EVERY_KIND);
  });

  test('logs one line per run: kind, run id, compared, matched and byCategory', async () => {
    const { processor, logger } = harness();
    const { job, saved } = fakeJob();

    const { logged } = await handle(processor, logger, job);

    expect(logged).toEqual([
      { kind: 'balance', runId: 'run-b', compared: 10, matched: 8, byCategory: { unexplained: 2 } },
      {
        kind: 'value',
        runId: 'run-v',
        compared: 4,
        matched: 3,
        byCategory: { 'price-moved-since': 1 },
      },
    ]);
    expect(saved).toEqual([
      { engineShadowKindsDone: { jobId: 'job-1', kinds: ['balance'] } },
      { engineShadowKindsDone: { jobId: 'job-1', kinds: ['balance', 'value'] } },
    ]);
  });

  test('a failed value run leaves the recorded balance run done, so a retry runs value alone', async () => {
    const { processor, logger } = harness(['value']);
    const { job, saved } = fakeJob();

    const { error } = await handle(processor, logger, job);

    expect((error as Error).message).toBe('value broke');
    expect(saved).toEqual([{ engineShadowKindsDone: { jobId: 'job-1', kinds: ['balance'] } }]);
  });

  test('a failed run is neither logged nor saved as done, so a retry runs it again', async () => {
    const { processor, logger } = harness(['balance']);
    const { job, saved } = fakeJob();

    const { logged, error } = await handle(processor, logger, job);

    expect((error as Error).message).toBe('balance broke');
    expect(logged).toEqual([]);
    expect(saved).toEqual([]);
  });

  test('a retry runs only the kinds an earlier attempt did not record', async () => {
    const { processor, inputs, logger } = harness();
    const { job, saved } = fakeJob({
      engineShadowKindsDone: { jobId: 'job-1', kinds: ['balance'] },
    });

    await handle(processor, logger, job);

    expect(inputs[0]?.kinds).toEqual(['value']);
    expect(saved).toEqual([
      { engineShadowKindsDone: { jobId: 'job-1', kinds: ['balance', 'value'] } },
    ]);
  });

  test("another job's done list is nothing done, so a list leaking into a later night skips no kind", async () => {
    // If the list ever reached the scheduler's template, every later night's
    // job would start with it. Its job id is what tells this night from that one.
    const { processor, inputs, logger } = harness();
    const { job, saved } = fakeJob(
      { engineShadowKindsDone: { jobId: 'job-1', kinds: ['balance'] } },
      'job-2'
    );

    await handle(processor, logger, job);

    expect(inputs[0]?.kinds).toEqual(EVERY_KIND);
    expect(saved.at(-1)).toEqual({
      engineShadowKindsDone: { jobId: 'job-2', kinds: EVERY_KIND },
    });
  });

  test('a done list it cannot read reruns every kind rather than skipping one', async () => {
    const { processor, inputs, logger } = harness();

    const unreadable: unknown[] = [
      'balance',
      ['balance'],
      { jobId: 'job-1', kinds: 'balance' },
      { jobId: 'job-1', kinds: ['balances', 7] },
      { kinds: ['balance'] },
      // A retry of a job queued before the price shadow was deleted.
      { jobId: 'job-1', kinds: ['price', 'balance'] },
    ];
    for (const done of unreadable) {
      await handle(processor, logger, fakeJob({ engineShadowKindsDone: done }).job);
    }

    expect(inputs.map((i) => i.kinds)).toEqual(unreadable.map(() => EVERY_KIND));
  });
});
