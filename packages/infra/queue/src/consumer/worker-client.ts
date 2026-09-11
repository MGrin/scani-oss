import { createComponentLogger } from '@scani/logging';
import { withSpan } from '@scani/logging/sentry';
import {
  createPostgresBackend,
  type Job,
  type PostgresQueueBackend,
  Queue,
  UnrecoverableError,
  WaitingError,
  Worker,
} from 'bullmq';

// `Queue` and `Worker` are generic over the backend and DEFAULT to
// `RedisQueueBackend`. Passing `createPostgresBackend` produces the Postgres
// variant, which is not assignable to that default — so the backend has to be
// named once here rather than inferred at each site.
type PgQueue = Queue<any, any, string, any, any, string, PostgresQueueBackend>;
type PgWorker = Worker<any, any, string, PostgresQueueBackend>;

import { Container, Service } from 'typedi';
import { DEFAULT_DLQ_NAME, DEFAULT_QUEUE_NAME } from '../core/default-names';
import { isScheduledJobDescriptor } from '../core/job-descriptor';
import { userFacingMessage } from '../core/user-facing';
import { interruptIdleWait } from '../wake/worker-wake';
import { LIFECYCLE_MIRROR, type LifecycleMirror } from './lifecycle-mirror';
import type { ScheduledJobProcessor } from './scheduled-job-processor';
import { Semaphore } from './semaphore';
import type { UserJobProcessor } from './user-job-processor';

const log = createComponentLogger('queue:worker-client');

// The longest an idle worker blocks without touching the database. It bounds
// how late a job enqueued while the compute was suspended can start: the
// suspend kills the LISTEN connection, the NOTIFY has nobody to reach, and the
// job waits for this timer. On Neon that is at most 900 - 300 = 600s, because
// the suspend comes at least 300s into the wait. 900 matches the fastest
// schedule (every 15 minutes), so production wakes no more often than it
// already does.
const IDLE_BLOCK_SECONDS = 900;
// Must exceed the 300s suspend window too, or it alone keeps the compute up. A
// job orphaned by a dead worker is reclaimed within two intervals.
const STALLED_INTERVAL_MS = 600_000;
// BullMQ's default, set on purpose (SC-1146). A restart no longer spends it —
// `close(true)` hands in-flight jobs back — so a stall now means the process
// died mid-job, and a job that kills it twice is failed rather than retried
// into a crash loop.
const MAX_STALLED_COUNT = 1;

export interface WorkerClientConfig {
  /** Postgres connection string — the same DATABASE_URL the app already uses. */
  connection: string;
  /** Schema holding BullMQ's tables. Defaults to `bullmq`. */
  schema?: string;
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
}

type ProcessorClass =
  | UserJobProcessor<{ userId: string; requestId: string }, unknown>
  | ScheduledJobProcessor;

export type TerminalFailureHook = (job: Job, err: Error) => void;

interface InFlightJob {
  job: Job;
  token: string | undefined;
  handedBack: boolean;
  abandon: (err: Error) => void;
}

// Wraps a single BullMQ Worker. Owns the per-job-name dispatch table and
// the DLQ push on terminal failure. Application-policy concerns (Sentry
// capture, custom alerting) plug in via `onTerminalFailure(hook)`.
//
// Lifecycle: configure() → register(processor) × N → start(). Calling
// register() after start() throws — BullMQ doesn't support hot-swap of
// the dispatch closure.
@Service()
export class WorkerClient {
  private worker: PgWorker | null = null;
  private dlq: PgQueue | null = null;
  private config: WorkerClientConfig | null = null;
  private readonly processors = new Map<string, (job: Job) => Promise<unknown>>();
  // Names of processors that came from a ScheduledJobDescriptor. Used
  // to gate scheduled jobs through the cron semaphore at dispatch time
  // without leaking the descriptor type into the runtime hot path.
  private readonly scheduledNames = new Set<string>();
  private cronSemaphore: Semaphore | null = null;
  private readonly terminalFailureHooks: TerminalFailureHook[] = [];
  private readonly inFlight = new Map<string, InFlightJob>();
  private handingBack = false;
  private closing: Promise<void> | null = null;

  configure(config: WorkerClientConfig): void {
    if (this.config) {
      throw new Error('WorkerClient already configured — call close() before reconfiguring');
    }
    this.config = config;
    this.dlq = new Queue(
      config.dlqName ?? DEFAULT_DLQ_NAME,
      {
        connection: { connectionString: config.connection, schema: config.schema ?? 'bullmq' },
      } as never,
      createPostgresBackend
    );
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

  // The one place every job — scheduled and user-initiated alike — is
  // dispatched, and therefore the one place a span has to be asked for
  // (SC-822). Nothing instruments a BullMQ consumer on its own: the SDK's
  // default integrations patch `node:http`, and a worker is not an HTTP
  // server, so before this a deployment reported errors normally and no
  // performance data at all — which reads as a working monitoring setup right
  // up until somebody asks how long a job takes.
  //
  // The span opens AFTER the semaphore, so its duration is the same window as
  // the `durationMs` on the completion log line below. Time spent waiting for
  // a cron-budget slot is queue latency rather than the job being slow, and
  // folding it in would make the two numbers disagree with no way to tell
  // which question a reader was asking.
  //
  // The race is what lets `handBack()` end an attempt BullMQ is still waiting
  // on: the handler cannot be cancelled, so the attempt settles with
  // `WaitingError` instead, which BullMQ records as nothing at all.
  private async runJob(job: Job, token: string | undefined): Promise<unknown> {
    const id = String(job.id);
    let abandon!: (err: Error) => void;
    const abandoned = new Promise<never>((_, reject) => {
      abandon = reject;
    });
    const entry: InFlightJob = { job, token, handedBack: false, abandon };
    this.inFlight.set(id, entry);
    try {
      if (this.handingBack) await this.handBackOne(entry);
      const work = this.dispatch(entry);
      // A handed-back handler still settles later, with nobody awaiting it.
      work.catch(() => undefined);
      return await Promise.race([work, abandoned]);
    } finally {
      this.inFlight.delete(id);
    }
  }

  private async dispatch(entry: InFlightJob): Promise<unknown> {
    const { job } = entry;
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
    if (entry.handedBack) {
      release?.();
      return undefined;
    }
    const start = Date.now();
    log.info({ jobId: job.id, name: job.name }, '▶️ Processing job');
    try {
      // `job.name` and not the job id: a span name is what Sentry aggregates
      // on, so it has to be the bounded set (one per registered processor)
      // rather than one name per execution.
      const result = await withSpan({ name: job.name, op: 'queue.process', source: 'task' }, () =>
        processor(job)
      );
      log.info(
        { jobId: job.id, name: job.name, durationMs: Date.now() - start },
        '✅ Job completed'
      );
      return result;
    } finally {
      if (release) release();
    }
  }

  async start(): Promise<PgWorker> {
    if (!this.config) {
      throw new Error('WorkerClient not configured — call configure() at boot');
    }
    if (this.worker) return this.worker;
    const cfg = this.config;
    const queueName = cfg.queueName ?? DEFAULT_QUEUE_NAME;

    this.worker = new Worker(
      queueName,
      (job, token) => this.runJob(job, token),
      {
        connection: { connectionString: cfg.connection, schema: cfg.schema ?? 'bullmq' },
        concurrency: cfg.concurrency ?? 1,
        // SC-963. Neon suspends a compute only after 300s with no query, so an
        // idle worker has to leave the database alone for longer than that.
        // Stock BullMQ caps the blocking wait at 10s whenever a delayed job
        // exists (every repeatable schedule is one) and runs the stalled
        // check every 30s, so the suspend window was never reached.
        // `maximumBlockTimeout` is an option only because
        // `patches/bullmq@6.2.0.patch` makes it one — upstream it is a
        // hardcoded constant (taskforcesh/bullmq#4601).
        drainDelay: IDLE_BLOCK_SECONDS,
        maximumBlockTimeout: IDLE_BLOCK_SECONDS,
        stalledInterval: STALLED_INTERVAL_MS,
        maxStalledCount: MAX_STALLED_COUNT,
      } as never,
      createPostgresBackend
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
        // BullMQ hands the `failed` listener the error object the processor
        // threw, in-process, so the `userFacing` brand is still readable here
        // (SC-551). It has to be read again rather than reused from the
        // processor's own catch: a payload that fails validation throws before
        // any other lifecycle event exists, and this is the only write it gets.
        userFacingError: userFacingMessage(err),
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
   * `close(false)` waits for every in-flight job to finish, which a long
   * job (a 400-day portfolio backfill runs ~45 min) never does inside
   * Fly's 30s grace period.
   *
   * `close(true)` hands every in-flight job back to `waiting` first
   * (`handBack()`), then closes. It also completes a `close(false)` that
   * is already pending, because the jobs it was waiting on have returned.
   *
   * Before SC-1146 neither was true. BullMQ's own force-close writes
   * nothing, so the job stayed `active` until its lock expired and the
   * stalled check reclaimed it — one stalled interval (600s) after the next
   * boot, spending the one stall `maxStalledCount` allows, so a second
   * deploy failed the job outright. And a force-close after a pending `close(false)` returned
   * BullMQ's same pending promise and waited on the job it was meant to
   * abandon.
   */
  async close(force = false): Promise<void> {
    if (force) await this.handBack();
    this.closing ??= this.closeWorker(force);
    const closing = this.closing;
    await closing;
    if (this.closing === closing) this.closing = null;
  }

  private async closeWorker(force: boolean): Promise<void> {
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
    this.handingBack = false;
  }

  /**
   * Move every in-flight job back to `waiting` with its lock token, so the
   * next worker picks it up at once. It spends neither an attempt nor a
   * stall, and it is only reached on a graceful shutdown: a process that
   * dies runs none of this, and its jobs are reclaimed by the stalled check
   * and counted against `maxStalledCount`. That asymmetry is the point — it
   * is what tells a long job apart from one that kills the worker.
   *
   * The handlers keep running until the process exits; their results are
   * discarded, because the token they would commit with is no longer the
   * job's.
   */
  async handBack(): Promise<void> {
    if (!this.worker) return;
    this.handingBack = true;
    // Paused, so BullMQ does not fetch a replacement for each job returned.
    await this.worker.pause(true);
    await Promise.all([...this.inFlight.values()].map((entry) => this.handBackOne(entry)));
  }

  private async handBackOne(entry: InFlightJob): Promise<void> {
    if (entry.handedBack) return;
    entry.handedBack = true;
    const { job } = entry;
    try {
      await job.moveToWait(entry.token);
      log.warn({ jobId: job.id, name: job.name }, '↩️ Handed an in-flight job back to waiting');
    } catch (err) {
      log.error(
        { jobId: job.id, name: job.name, error: err instanceof Error ? err.message : String(err) },
        'Could not hand the job back — the stalled check will reclaim it'
      );
    }
    entry.abandon(new WaitingError());
  }

  /** Poll now instead of at the idle timer — the api's ping after an enqueue (SC-1144). */
  wake(): void {
    if (this.worker) interruptIdleWait(this.worker);
  }

  // Total DLQ entries (waiting / delayed / active; failed jobs land in 'waiting'
  // since the DLQ has no consumer). Used by the DLQ-depth probe to
  // surface backlogs that would otherwise silently accumulate until
  // someone notices in the admin UI.
  async getDlqDepth(): Promise<number> {
    if (!this.dlq) return 0;
    const counts = await this.dlq.getJobCounts('waiting', 'delayed', 'active');
    return Object.values(counts).reduce((sum, n) => sum + (typeof n === 'number' ? n : 0), 0);
  }
}
