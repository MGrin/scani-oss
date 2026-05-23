import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Container } from 'typedi';
import { JOB_LOCK, JobLock } from '../../src/consumer/job-lock';
import { ScheduledJobProcessor } from '../../src/consumer/scheduled-job-processor';
import type { ScheduledJobDescriptor } from '../../src/core/job-descriptor';

class StubProcessor extends ScheduledJobProcessor {
  readonly descriptor: ScheduledJobDescriptor;
  public ranCount = 0;
  constructor(descriptor: ScheduledJobDescriptor) {
    super();
    this.descriptor = descriptor;
  }
  protected async handle(): Promise<void> {
    this.ranCount++;
  }
}

class GrantingLock extends JobLock {
  override async withLock<T>(_: string, fn: () => Promise<T>) {
    return { ran: true as const, result: await fn() };
  }
}

class HoldingLock extends JobLock {
  override async withLock(): Promise<{ ran: false }> {
    return { ran: false };
  }
}

beforeEach(() => {
  Container.remove(JOB_LOCK);
});
afterEach(() => {
  Container.remove(JOB_LOCK);
});

describe('ScheduledJobProcessor', () => {
  test('runs unlocked when descriptor has no lockName', async () => {
    Container.set(JOB_LOCK, new HoldingLock());
    const proc = new StubProcessor({ name: 'no-lock', cron: '* * * * *' });
    await proc.process({} as never);
    expect(proc.ranCount).toBe(1);
  });

  test('runs unlocked when no JobLock impl is registered', async () => {
    const proc = new StubProcessor({ name: 'pricing', cron: '0 * * * *', lockName: 'pricing' });
    await proc.process({} as never);
    expect(proc.ranCount).toBe(1);
  });

  test('acquires lock + runs when impl is registered and grants', async () => {
    Container.set(JOB_LOCK, new GrantingLock());
    const proc = new StubProcessor({ name: 'pricing', cron: '0 * * * *', lockName: 'pricing' });
    await proc.process({} as never);
    expect(proc.ranCount).toBe(1);
  });

  test('skips silently (no throw, no run) when lock is held by another instance', async () => {
    Container.set(JOB_LOCK, new HoldingLock());
    const proc = new StubProcessor({ name: 'pricing', cron: '0 * * * *', lockName: 'pricing' });
    await proc.process({} as never);
    expect(proc.ranCount).toBe(0);
  });

  test('passes through handler errors (caller sees the throw)', async () => {
    Container.set(JOB_LOCK, new GrantingLock());
    class FailingProc extends ScheduledJobProcessor {
      readonly descriptor = { name: 'pricing', cron: '0 * * * *', lockName: 'pricing' };
      protected async handle(): Promise<void> {
        throw new Error('processor exploded');
      }
    }
    await expect(new FailingProc().process({} as never)).rejects.toThrow('processor exploded');
  });
});
