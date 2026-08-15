import { createComponentLogger } from '@scani/logging';
import { type Job, Queue, UnrecoverableError, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { Container, Service } from 'typedi';
import { DEFAULT_DLQ_NAME, DEFAULT_QUEUE_NAME } from '../core/default-names';
import { isScheduledJobDescriptor } from '../core/job-descriptor';
import { LIFECYCLE_MIRROR, type LifecycleMirror } from './lifecycle-mirror';
import type { ScheduledJobProcessor } from './scheduled-job-processor';
import { Semaphore } from './semaphore';
import type { UserJobProcessor } from './user-job-processor';

const log = createComponentLogger('queue:worker-client');

export interface WorkerClientConfig {
  connection: Redis;
  queueName?: string;
  dlqName?: string;
  /** Total in-flight job slots across the worker. */
  concurrency?: number;
  /**
   * Optional cap on how many scheduled (cron-triggered) jobs run in
   * parallel. When unset, scheduled jobs share the global pool, which
   * means the hourly tide (pricing + wallet-balances + exchange-
   * balances all firing at minute 0) can starve user-initiated jobs of
   * concurrency slots. Set this to a value < `concurrency` to reserve
   * slack for user work.
   */
  cronConcurrency?: number;
  drainDelay?: number;
}

type ProcessorClass =
  | UserJobProcessor<{ userId: string; requestId: string }, unknown>
  | ScheduledJobProcessor;

export type TerminalFailureHook = (job: Job, err: Error) => void;

// Wraps a single BullMQ Worker. Owns the per-job-name dispatch table and
// the DLQ push on terminal failure. Application-policy concerns (Sentry
// capture, custom alerting) plug in via `onTerminalFailure(hook)`.
//
// Lifecycle: configure() → register(processor) × N → start(). Calling
// register() after start() throws — BullMQ doesn't support hot-swap of
// the dispatch closure.
@Service()
export class WorkerClient {
  private worker: Worker | null = null;
  private dlq: Queue | null = null;
  private config: WorkerClientConfig | null = null;
  private readonly processors = new Map<string, (job: Job) => Promise<unknown>>();
  // Names of processors that came from a ScheduledJobDescriptor. Used
  // to gate scheduled jobs through the cron semaphore at dispatch time
  // without leaking the descriptor type into the runtime hot path.
  private readonly scheduledNames = new Set<string>();
  private cronSemaphore: Semaphore | null = null;
  private readonly terminalFailureHooks: TerminalFailureHook[] = [];

  configure(config: WorkerClientConfig): void {
    if (this.config) {
      throw new Error('WorkerClient already configured — call close() before reconfiguring');
    }
    this.config = config;
    this.dlq = new Queue(config.dlqName ?? DEFAULT_DLQ_NAME, { connection: config.connection });
    this.cronSemaphore =
      typeof config.cronConcurrency === 'number' && config.cronConcurrency > 0
        ? new Semaphore(config.cronConcurrency)
        : null;
  }

  register(processor: ProcessorClass): void {
    if (this.worker) {
      throw new Error(
        'Cannot register a processor after WorkerClient.start() — BullMQ does not support hot-swap'
      );
    }
    const name = processor.descriptor.name;
    if (this.processors.has(name)) {
      throw new Error(`Processor for job '${name}' already registered`);
    }
    this.processors.set(name, (job) => processor.process(job));
    if (isScheduledJobDescriptor(processor.descriptor)) {
      this.scheduledNames.add(name);
    }
    log.info({ name }, '🔧 Registered processor');
  }

  // Application-policy hook fired on terminal failure (after BullMQ has
  // exhausted retries). Multiple hooks supported; each runs once. The
  // generic DLQ push is owned by WorkerClient and runs regardless.
  onTerminalFailure(hook: TerminalFailureHook): void {
    this.terminalFailureHooks.push(hook);
  }

  async start(): Promise<Worker> {
    if (!this.config) {
      throw new Error('WorkerClient not configured — call configure() at boot');
    }
    if (this.worker) return this.worker;
    const cfg = this.config;
    const queueName = cfg.queueName ?? DEFAULT_QUEUE_NAME;

    this.worker = new Worker(
      queueName,
      async (job) => {
        const processor = this.processors.get(job.name);
        if (!processor) throw new Error(`No processor registered for job '${job.name}'`);
        // Gate scheduled jobs through the cron semaphore (when one was
        // configured) so the hourly cron tide can't pin the entire
        // worker concurrency budget. The slot is held in BullMQ either
        // way — the semaphore just stalls the actual handler invocation
        // until a cron-budget slot frees up.
        const release =
          this.cronSemaphore && this.scheduledNames.has(job.name)
            ? await this.cronSemaphore.acquire()
            : null;
        const start = Date.now();
        log.info({ jobId: job.id, name: job.name }, '▶️ Processing job');
        try {
          const result = await processor(job);
          log.info(
            { jobId: job.id, name: job.name, durationMs: Date.now() - start },
            '✅ Job completed'
          );
          return result;
        } finally {
          if (release) release();
        }
      },
      {
        connection: cfg.connection.duplicate(),
        concurrency: cfg.concurrency ?? 1,
        // drainDelay 5s keeps idle pickup snappy for user-initiated
        // jobs without burning Upstash polls; bump for cost-sensitive
        // deploys with no user-facing jobs.
        drainDelay: cfg.drainDelay ?? 5,
      }
    );

    this.worker.on('failed', async (job, err) => {
      if (!job) return;
      log.error(
        { jobId: job.id, name: job.name, error: err instanceof Error ? err.message : String(err) },
        '❌ Job failed'
      );
      // Two ways the queue stops trying, and they are not the same event.
      // `UnrecoverableError` skips the remaining attempts by design, so
      // `attemptsMade` never reaches the ceiling — which is why terminality
      // cannot be read off the counter alone.
      const unrecoverable = err instanceof UnrecoverableError;
      const retriesExhausted = job.attemptsMade >= (job.opts.attempts ?? 1);
      if (!unrecoverable && !retriesExhausted) return;

      // Tell the durable mirror the job is over (SC-153). This is the only
      // place that knows it: the processor writes `state='failed'` from its
      // own catch, but that fires on every attempt and cannot see whether
      // another is coming — and it never fires at all for a payload that
      // fails validation, which used to leave the row at 'queued' with
      // nothing to correct it.
      await this.markDead(job, err, unrecoverable);

      // Application-policy hooks (Sentry, alerts). UnrecoverableError is
      // BullMQ's signal for a classified by-design terminal failure (bad
      // creds, wrong import path, …) — surface to user via UI but skip
      // alerting to avoid burying real bugs in noise.
      if (!unrecoverable) {
        for (const hook of this.terminalFailureHooks) {
          try {
            hook(job, err);
          } catch (hookErr) {
            log.error(
              { error: hookErr instanceof Error ? hookErr.message : String(hookErr) },
              'Terminal-failure hook threw'
            );
          }
        }
      }

      // DLQ push — generic infra; preserves the failure for later replay
      // even after BullMQ's removeOnFail truncates the original.
      //
      // 14-day age cap on both completed + failed: prod hit a 1671-row
      // DLQ in two weeks under `removeOnComplete:false, removeOnFail:false`
      // (one busted reconciler firing every minute), which made the
      // admin UI unusable and saturated Upstash storage. The DLQ is for
      // post-mortem of recent failures, not historical archival — older
      // entries are noise.
      //
      // Gated on `retriesExhausted` rather than on terminality so this
      // stays exactly what it was before SC-153: a by-design
      // `UnrecoverableError` is not a post-mortem candidate, and putting
      // one in here would raise the DLQ-depth alert for a user typing the
      // wrong API key.
      if (retriesExhausted && this.dlq) {
        try {
          await this.dlq.add(
            job.name,
            {
              originalJobId: job.id,
              originalName: job.name,
              data: job.data,
              failedReason: err instanceof Error ? err.message : String(err),
              stack: err instanceof Error ? err.stack : undefined,
              attemptsMade: job.attemptsMade,
              timestamp: Date.now(),
            },
            {
              removeOnComplete: { age: 14 * 24 * 60 * 60 },
              removeOnFail: { age: 14 * 24 * 60 * 60 },
            }
          );
          log.warn({ jobId: job.id, name: job.name }, '☠️ Job pushed to DLQ');
        } catch (dlqErr) {
          log.error({ error: dlqErr }, '⚠️ Failed to write to DLQ');
        }
      }
    });

    log.info(
      {
        queue: queueName,
        concurrency: cfg.concurrency ?? 1,
        cronConcurrency: cfg.cronConcurrency ?? null,
        processors: this.processors.size,
        scheduledProcessors: this.scheduledNames.size,
      },
      '🎧 Worker listening for jobs'
    );
    return this.worker;
  }

  /**
   * Record "the queue has given up on this job" in the durable mirror.
   *
   * Scheduled jobs are skipped: they have no user and no row to write, and
   * their terminal failures are what the DLQ-depth probe and the alerting
   * hooks are for. Best-effort, like every other mirror write — a failure
   * here must not stop the DLQ push that follows it, which is the copy that
   * still allows a replay.
   */
  private async markDead(job: Job, err: Error, unrecoverable: boolean): Promise<void> {
    if (this.scheduledNames.has(job.name) || !this.processors.has(job.name)) return;
    const userId = (job.data as { userId?: unknown } | undefined)?.userId;
    if (typeof userId !== 'string' || !userId) return;

    let mirror: LifecycleMirror;
    try {
      mirror = Container.get(LIFECYCLE_MIRROR);
    } catch {
      // No durable mirror registered (Tier-1 OSS deploys run without a
      // per-user job table). Live events still went out over pub/sub.
      return;
    }

    try {
      await mirror.onLifecycle({
        type: 'dead',
        jobId: String(job.id),
        userId,
        jobName: job.name,
        error: err instanceof Error ? err.message : String(err),
        attemptsMade: job.attemptsMade,
        attemptsAllowed: (job.opts.attempts as number | undefined) ?? 1,
        reason: unrecoverable ? 'unrecoverable' : 'retries_exhausted',
      });
    } catch (mirrorErr) {
      log.error(
        {
          jobId: job.id,
          name: job.name,
          error: mirrorErr instanceof Error ? mirrorErr.message : String(mirrorErr),
        },
        'Failed to mark job dead in the durable mirror — the row will read as merely failed'
      );
    }
  }

  /**
   * Close the worker.
   *
   * Default (force=false): BullMQ waits for every in-flight job to
   * complete before resolving. With long-running processors
   * (portfolio-history-backfill at ~35s, wallet-import at ~75s) this
   * can exceed Fly's 30s grace_period and the platform will SIGKILL
   * the process mid-shutdown — leaving Sentry breadcrumbs unflushed
   * and possibly corrupting BullMQ lock state.
   *
   * Callers (worker app graceful shutdown) should wrap this in a
   * Promise.race with their own timeout, log active count, and call
   * close(true) on timeout to force-cancel remaining jobs (BullMQ
   * marks them as `failed` so they retry on the next worker boot).
   */
  async close(force = false): Promise<void> {
    if (this.worker) {
      await this.worker.close(force);
      this.worker = null;
    }
    if (this.dlq) {
      await this.dlq.close();
      this.dlq = null;
    }
    this.processors.clear();
    this.scheduledNames.clear();
    this.cronSemaphore = null;
    this.terminalFailureHooks.length = 0;
    this.config = null;
  }

  // Total DLQ entries (waiting / paused; failed jobs land in 'waiting'
  // since the DLQ has no consumer). Used by the DLQ-depth probe to
  // surface backlogs that would otherwise silently accumulate until
  // someone notices in the admin UI.
  async getDlqDepth(): Promise<number> {
    if (!this.dlq) return 0;
    const counts = await this.dlq.getJobCounts('waiting', 'paused', 'delayed', 'active');
    return Object.values(counts).reduce((sum, n) => sum + (typeof n === 'number' ? n : 0), 0);
  }
}
