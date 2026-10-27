import { JOB_NAMES } from '@scani/jobs';
import { createComponentLogger } from '@scani/logging';
import type { LifecycleEvent, LifecycleMirror } from '@scani/queue';

const log = createComponentLogger('returns-precompute');

/**
 * How long a user's writes must be quiet before Home's returns are computed.
 * An app open's 13 balance refreshes landed over 26 s on production
 * (2026-10-27, 08:25:53 to 08:26:19), so each one re-arms the wait.
 */
const RETURNS_PRECOMPUTE_DELAY_MS = 30_000;

/**
 * One precompute per user once their writes settle, one at a time (SC-1745).
 * In memory on purpose: the worker is one machine, and a precompute lost to a
 * restart only means the next Home load computes, as it did before.
 */
export class ReturnsPrecomputeScheduler {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly run: (userId: string) => Promise<unknown>,
    private readonly delayMs = RETURNS_PRECOMPUTE_DELAY_MS
  ) {}

  schedule(userId: string): void {
    const armed = this.timers.get(userId);
    if (armed) clearTimeout(armed);
    this.timers.set(
      userId,
      setTimeout(() => {
        this.timers.delete(userId);
        this.chain = this.chain.then(() => this.runLogged(userId));
      }, this.delayMs)
    );
  }

  /** Test seam: resolves once every precompute already started has ended. */
  idle(): Promise<void> {
    return this.chain;
  }

  private async runLogged(userId: string): Promise<void> {
    const started = performance.now();
    const cpu = process.cpuUsage();
    try {
      const outcome = await this.run(userId);
      const used = process.cpuUsage(cpu);
      log.info(
        {
          userId,
          outcome,
          ms: Math.round(performance.now() - started),
          cpuMs: Math.round((used.user + used.system) / 1000),
        },
        'returns precomputed'
      );
    } catch (error) {
      log.warn({ userId, err: error }, 'returns precompute failed; Home computes on open');
    }
  }
}

/**
 * The durable user-job mirror, plus: a completed user job schedules Home's
 * returns for its owner. Nearly every user job writes something the returns
 * version reads, and one that did not costs a version read and three cache
 * reads, so the trigger is every completion but an account deletion.
 */
export class PrecomputingLifecycleMirror implements LifecycleMirror {
  constructor(
    private readonly inner: LifecycleMirror,
    private readonly scheduler: Pick<ReturnsPrecomputeScheduler, 'schedule'>
  ) {}

  async isCancelled(jobId: string): Promise<boolean> {
    return (await this.inner.isCancelled?.(jobId)) ?? false;
  }

  async onLifecycle(event: LifecycleEvent): Promise<void> {
    await this.inner.onLifecycle(event);
    if (event.type === 'completed' && event.jobName !== JOB_NAMES.userDataDelete) {
      this.scheduler.schedule(event.userId);
    }
  }
}
