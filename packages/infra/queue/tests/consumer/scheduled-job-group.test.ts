import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Container } from 'typedi';
// This workspace cannot depend on @scani/domain (it sits below it), so the
// shared helper is reached the same way the shared test preload is: by path.
import { restoreContainerAfterAll } from '../../../../business/domain/test/helpers/container';
import { JOB_HEARTBEAT_WRITER, JobHeartbeatWriter } from '../../src/consumer/job-heartbeat-writer';
import { JOB_LOCK, JobLock } from '../../src/consumer/job-lock';
import {
  type GroupRunSummary,
  ScheduledJobGroupProcessor,
} from '../../src/consumer/scheduled-job-group';
import { ScheduledJobProcessor } from '../../src/consumer/scheduled-job-processor';
import type {
  ScheduledJobGroupDescriptor,
  ScheduledJobStepDescriptor,
} from '../../src/core/job-descriptor';

restoreContainerAfterAll();

const calls: string[] = [];

class Step extends ScheduledJobProcessor {
  readonly descriptor: ScheduledJobStepDescriptor;
  constructor(
    name: string,
    private readonly behave: (attempt: number) => Promise<void> = async () => undefined,
    lockName?: string
  ) {
    super();
    this.descriptor = { name, lockName };
  }
  attempts = 0;
  protected async handle(): Promise<void> {
    this.attempts++;
    calls.push(this.descriptor.name);
    await this.behave(this.attempts);
  }
}

class RecordingWriter extends JobHeartbeatWriter {
  rows: Array<{ jobName: string; success: boolean; errorMessage?: string }> = [];
  override async record(input: { jobName: string; success: boolean; errorMessage?: string }) {
    this.rows.push({
      jobName: input.jobName,
      success: input.success,
      errorMessage: input.errorMessage,
    });
  }
}

class HoldingLockFor extends JobLock {
  constructor(private readonly held: string) {
    super();
  }
  override async withLock<T>(name: string, fn: () => Promise<T>) {
    if (name === this.held) return { ran: false as const };
    return { ran: true as const, result: await fn() };
  }
}

function fakeJob(progress: unknown = undefined) {
  const job = {
    id: 'repeat:scheduler:nightly:1',
    data: {},
    progress,
    async updateProgress(p: unknown) {
      job.progress = p;
    },
  };
  return job;
}

function group(
  steps: Array<{ name: string; runOn?: (at: Date) => boolean; timeoutMs?: number }>
): ScheduledJobGroupDescriptor {
  return { name: 'nightly', cron: '0 0 * * *', steps };
}

let writer: RecordingWriter;
beforeEach(() => {
  calls.length = 0;
  writer = new RecordingWriter();
  Container.set(JOB_HEARTBEAT_WRITER, writer);
  Container.remove(JOB_LOCK);
});
afterEach(() => {
  Container.remove(JOB_LOCK);
});

const noBackoff = { attempts: 3, backoffMs: () => 0 };

describe('ScheduledJobGroupProcessor (SC-1688)', () => {
  test('runs every step in order and a failing step skips none after it', async () => {
    const failures: string[] = [];
    const runner = new ScheduledJobGroupProcessor(
      group([{ name: 'a' }, { name: 'b' }, { name: 'c' }]),
      [
        new Step('a'),
        new Step('b', async () => {
          throw new Error('b broke');
        }),
        new Step('c'),
      ],
      { retry: noBackoff, onStepFailure: (step) => failures.push(step) }
    );
    const summary = (await runner.process(fakeJob() as never)) as GroupRunSummary;
    expect(calls).toEqual(['a', 'b', 'b', 'b', 'c']);
    expect(summary.steps.map((s) => [s.name, s.status])).toEqual([
      ['a', 'ok'],
      ['b', 'failed'],
      ['c', 'ok'],
    ]);
    expect(summary.steps[1]?.error).toBe('b broke');
    expect(summary.steps[1]?.attempts).toBe(3);
    expect(typeof summary.steps[0]?.durationMs).toBe('number');
    expect(failures).toEqual(['b']);
  });

  test('a step that fails once and then succeeds is ok, retried inside the run', async () => {
    const runner = new ScheduledJobGroupProcessor(
      group([{ name: 'flaky' }]),
      [
        new Step('flaky', async (attempt) => {
          if (attempt === 1) throw new Error('blip');
        }),
      ],
      { retry: noBackoff }
    );
    const summary = (await runner.process(fakeJob() as never)) as GroupRunSummary;
    expect(summary.steps[0]).toMatchObject({ name: 'flaky', status: 'ok', attempts: 2 });
  });

  test('a re-attempt of the same occurrence skips the steps that already succeeded', async () => {
    const runner = new ScheduledJobGroupProcessor(
      group([{ name: 'a' }, { name: 'b' }]),
      [new Step('a'), new Step('b')],
      { retry: noBackoff }
    );
    const job = fakeJob({
      steps: { a: { status: 'ok', attempts: 1, durationMs: 5 } },
    });
    await runner.process(job as never);
    expect(calls).toEqual(['b']);
  });

  test('CONTROL: a failed step from the earlier attempt runs again', async () => {
    const runner = new ScheduledJobGroupProcessor(
      group([{ name: 'a' }, { name: 'b' }]),
      [new Step('a'), new Step('b')],
      { retry: noBackoff }
    );
    await runner.process(
      fakeJob({ steps: { a: { status: 'failed', attempts: 3, durationMs: 5 } } }) as never
    );
    expect(calls).toEqual(['a', 'b']);
  });

  test('progress is written after each step, so a stall mid-run keeps what finished', async () => {
    const job = fakeJob();
    const runner = new ScheduledJobGroupProcessor(
      group([{ name: 'a' }, { name: 'b' }]),
      [
        new Step('a'),
        new Step('b', async () => {
          expect(
            (job.progress as { steps: Record<string, { status: string }> }).steps.a?.status
          ).toBe('ok');
        }),
      ],
      { retry: noBackoff }
    );
    await runner.process(job as never);
    expect(calls).toEqual(['a', 'b']);
  });

  test('a step whose lock another worker holds is recorded as locked, not failed or retried', async () => {
    Container.set(JOB_LOCK, new HoldingLockFor('b'));
    const runner = new ScheduledJobGroupProcessor(
      group([{ name: 'a' }, { name: 'b' }, { name: 'c' }]),
      [new Step('a', undefined, 'a'), new Step('b', undefined, 'b'), new Step('c', undefined, 'c')],
      { retry: noBackoff }
    );
    const summary = (await runner.process(fakeJob() as never)) as GroupRunSummary;
    expect(calls).toEqual(['a', 'c']);
    expect(summary.steps.map((s) => s.status)).toEqual(['ok', 'locked', 'ok']);
  });

  test('a step past its time limit is recorded as timed out and the last step still runs', async () => {
    const runner = new ScheduledJobGroupProcessor(
      group([{ name: 'hangs', timeoutMs: 20 }, { name: 'db-backup' }]),
      [new Step('hangs', () => new Promise(() => undefined)), new Step('db-backup')],
      { retry: noBackoff }
    );
    const summary = (await runner.process(fakeJob() as never)) as GroupRunSummary;
    expect(summary.steps.map((s) => [s.name, s.status])).toEqual([
      ['hangs', 'timed-out'],
      ['db-backup', 'ok'],
    ]);
    expect(summary.steps[0]?.attempts).toBe(1);
  });

  test('a step whose day it is not is recorded as not-today and does not run', async () => {
    const runner = new ScheduledJobGroupProcessor(
      group([{ name: 'sundays', runOn: () => false }, { name: 'daily' }]),
      [new Step('sundays'), new Step('daily')],
      { retry: noBackoff }
    );
    const summary = (await runner.process(fakeJob() as never)) as GroupRunSummary;
    expect(calls).toEqual(['daily']);
    expect(summary.steps[0]?.status).toBe('not-today');
  });

  test('every step that ran writes its own heartbeat, and the group writes one for itself', async () => {
    const runner = new ScheduledJobGroupProcessor(
      group([{ name: 'a' }, { name: 'b' }]),
      [
        new Step('a'),
        new Step('b', async () => {
          throw new Error('no');
        }),
      ],
      { retry: noBackoff }
    );
    await runner.process(fakeJob() as never);
    const last = (name: string) => writer.rows.filter((r) => r.jobName === name).at(-1);
    expect(last('a')?.success).toBe(true);
    expect(last('b')).toMatchObject({ success: false, errorMessage: 'no' });
    expect(last('nightly')).toMatchObject({
      success: false,
      errorMessage: '1 of 2 steps failed: b',
    });
  });

  test('the group never throws, so BullMQ never re-runs it as a whole', async () => {
    const runner = new ScheduledJobGroupProcessor(
      group([{ name: 'a' }]),
      [
        new Step('a', async () => {
          throw new Error('always');
        }),
      ],
      { retry: noBackoff }
    );
    await expect(runner.process(fakeJob() as never)).resolves.toBeDefined();
  });

  test('a step named in the descriptor with no processor refuses at construction', () => {
    expect(
      () =>
        new ScheduledJobGroupProcessor(group([{ name: 'a' }, { name: 'ghost' }]), [new Step('a')], {
          retry: noBackoff,
        })
    ).toThrow(/ghost/);
  });
});
