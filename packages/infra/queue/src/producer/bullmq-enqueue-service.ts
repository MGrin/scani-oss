import { StoreCommandTimeoutError, withDeadline } from '@scani/deadline';
import { createComponentLogger } from '@scani/logging';
import type { JobsOptions } from 'bullmq';
import { Container, Service } from 'typedi';
import type { UserJobDescriptor } from '../core/job-descriptor';
import type { UserJobBase } from '../core/types';
import { ENQUEUE_MIRROR, type EnqueueMirror } from './enqueue-mirror';
import { EnqueueService } from './enqueue-service';
import { QueueClient } from './queue-client';

const logger = createComponentLogger('queue:enqueue');

/**
 * How long `queue.add` may wait for the queue's store before this enqueue is
 * reported as failed (SC-523, re-sized for Postgres by SC-578).
 *
 * **Without a bound the `catch` below never runs.** The store is Postgres
 * since SC-518, and BullMQ's Postgres backend runs `add_job` on a `pg.Pool`
 * built from a connection string alone — which leaves three separate waits
 * unbounded. `connectionTimeoutMillis` is unset, so a caller queuing for one
 * of the pool's ten slots gets no timer (`pg-pool/index.js:206`); no
 * `statement_timeout` is set on that pool, so the insert waits out whatever
 * holds the row lock; and a black-holed socket waits on the OS. Measured
 * 2026-08-22 through this exact class against `bullmq.job` held under `ACCESS
 * EXCLUSIVE`: still unsettled at 30s, resolving at 30684ms only because the
 * lock was released. Every api mutation that starts an import runs through
 * here, so that is the user's spinner never resolving.
 *
 * **Fail closed, not degrade** — the opposite of `PortfolioValueCache`
 * (SC-522), and for the reason `packages/infra/rate-limiter` already writes
 * down. Its inflow limiter degrades because the cost of guessing wrong is
 * self-inflicted and bounded; its outflow limiter refuses (SC-254) because the
 * damage is external and cannot be undone by the store coming back. An enqueue
 * is the outflow shape: a job silently not enqueued is work the user believes
 * is happening and which will never run, and no later event corrects that
 * belief. So the bound rejects, `onEnqueueFailed` marks the mirror row, and
 * the caller gets an error it can show.
 *
 * **10_000ms, sized against how long establishing a Postgres connection may
 * legitimately take — because on this backend that is most of what the bound
 * is timing.** The 2000ms it replaces was argued from ioredis's
 * `retryStrategy` topping out at one attempt every 2000ms, so a command
 * unanswered for a full retry interval was waiting on a store that was not
 * there. Nothing in that sentence survives the move to `pg`, and the number it
 * produced does not either: unlike the shared ioredis client, which connects
 * once at boot and leaves the bound timing a single warm round trip, BullMQ's
 * pool is built lazily and `pg-pool` expires an idle client after 10s
 * (`index.js:98`) — so on this traffic a connect, and on production a Neon
 * compute wake, land *inside* the bounded window. Measured 2026-08-22 against
 * a local container, no TLS and no wake: warm `add` p50 76ms / p99 1238ms
 * (n=200), first `add` in a fresh process 296–1266ms with a 3287ms outlier,
 * and an `add` after the pool's idle client expired 602ms / 1428ms. Production
 * adds TLS, the Fly-to-Neon round trip, and a ~1.1s cold start on a compute
 * that suspends after 300s and wakes ~72 times a day. 2000ms is not a
 * conservative bound on that path; it is roughly the path's own cost, and it
 * would fire on a healthy store. 10s is what this repo already budgets for
 * establishing a Postgres connection before calling it dead
 * (`connect_timeout: 10`, `packages/infra/db/src/connection.ts`).
 *
 * **Raising it does not weaken it, and that asymmetry is the whole argument.**
 * Every failure this catches is unbounded — a lock wait, a pool-slot wait, a
 * dead socket — so there is no failure that takes between 2s and 10s and gets
 * missed by the larger number. What the larger number costs is spinner
 * seconds against a store that is genuinely gone. What the smaller one costs
 * is a false failure on the ordinary cold path, and a false fire here is worse
 * than a wasted retry: the timed-out `add` is **not cancelled** (see
 * `withDeadline`), so it lands anyway, and the deterministic `jobId` does
 * **not** dedupe the user's retry — every `requestId` is a fresh
 * `crypto.randomUUID()` minted at click time in `apps/frontend/app`, so a
 * retry computes a *different* id. A false fire costs a duplicate job. Hence a
 * bound only an absent store can trip.
 *
 * **This is not the time a user waits for the error.** `mutations.retry` is
 * `failureCount < 1` in `packages/frontend/ui/src/lib/create-trpc-react.tsx`,
 * so a failing enqueue is attempted twice and the error surfaces at roughly
 * twice this bound. That is the retry working as configured (SC-578).
 */
const ENQUEUE_TIMEOUT_MS = 10_000;

@Service()
export class BullMqEnqueueService extends EnqueueService {
  private readonly queueClient = Container.get(QueueClient);

  override async add<TPayload extends UserJobBase, TResult>(
    descriptor: UserJobDescriptor<TPayload, TResult>,
    data: TPayload,
    overrides?: JobsOptions
  ): Promise<string> {
    const jobId = descriptor.computeJobId(data);
    const opts: JobsOptions = {
      jobId,
      ...descriptor.defaultOpts,
      ...overrides,
    };
    const attemptsAllowed = (opts.attempts as number | undefined) ?? 1;
    const mirror = this.tryGetMirror();

    if (mirror) {
      await mirror.onEnqueued({
        jobId,
        userId: data.userId,
        jobName: descriptor.name,
        payloadSummary: descriptor.summarizePayload(data),
        attemptsAllowed,
      });
    }

    try {
      await withDeadline(
        this.queueClient.get().add(descriptor.name, data, opts),
        ENQUEUE_TIMEOUT_MS,
        () => new StoreCommandTimeoutError('postgres', 'enqueue', ENQUEUE_TIMEOUT_MS)
      );
      logger.info(
        { jobId, jobName: descriptor.name, userId: data.userId, attemptsAllowed },
        'Job enqueued'
      );
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.error(
        {
          jobId,
          jobName: descriptor.name,
          userId: data.userId,
          err: error.message,
        },
        'Job enqueue failed'
      );
      if (mirror) {
        await mirror.onEnqueueFailed(jobId, error, {
          jobId,
          userId: data.userId,
          jobName: descriptor.name,
          attemptsAllowed,
        });
      }
      throw err;
    }
    return jobId;
  }

  // Optional mirror — domain wires one in cloud/managed deploys; OSS
  // and tests can skip. typedi throws on missing tokens, so we swallow.
  private tryGetMirror(): EnqueueMirror | null {
    try {
      return Container.get(ENQUEUE_MIRROR);
    } catch {
      return null;
    }
  }
}
