import { RedisCommandTimeoutError, withRedisTimeout } from '@scani/deadline';
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
 * reported as failed (SC-523).
 *
 * **Without a bound the `catch` below never runs.** The shared client is built
 * `{ maxRetriesPerRequest: null }` — BullMQ requires it — and ioredis 5.10.1
 * only flushes its offline queue `if (typeof maxRetriesPerRequest ===
 * "number")`, so an `add` issued while the connection is down is never
 * rejected. Measured 2026-08-21 through this exact class, against a real Redis
 * container stopped mid-flight: `HUNG 10003ms` against a 10s budget, where the
 * same call answers in ~2ms warm. Every api mutation that starts an import
 * runs through here, so that hang is the user's spinner never resolving.
 *
 * **Fail closed, not degrade** — the opposite of `PortfolioValueCache`
 * (SC-522), and for the reason `packages/infra/rate-limiter` already writes
 * down. Its inflow limiter degrades because the cost of guessing wrong is
 * self-inflicted and bounded; its outflow limiter refuses (SC-254) because the
 * damage is external and cannot be undone by Redis coming back. An enqueue is
 * the outflow shape: a job silently not enqueued is work the user believes is
 * happening and which will never run, and no later event corrects that
 * belief. So the bound rejects, `onEnqueueFailed` marks the mirror row, and
 * the caller gets an error it can show.
 *
 * **2000ms, sized against ioredis's retry cadence rather than a latency
 * budget** — the same reasoning and the same constant as the api's
 * `REDIS_PING_TIMEOUT_MS` (`apps/backend/api/src/index.ts`): the default
 * `retryStrategy` tops out at one attempt every 2000ms, so a command
 * unanswered for a full retry interval is not waiting on a slow store, it is
 * waiting on one that is not there. It is deliberately 8x the 250ms the
 * limiters and the value cache use, because a spurious fire costs a user a
 * false failure here rather than a cache miss.
 *
 * That asymmetry is worth stating plainly, because the obvious mitigation does
 * not hold: the timed-out `add` is **not cancelled** (ioredis has no such
 * API — see `withRedisTimeout`), so it may land after we have already reported
 * failure, and the deterministic `jobId` does **not** dedupe the user's retry —
 * every `requestId` is a fresh `crypto.randomUUID()` minted at click time in
 * `apps/frontend/app`, so a retry computes a *different* id. A false fire can
 * therefore cost a duplicate job, not merely a wasted retry. Hence a bound that
 * only an absent store can trip.
 */
const ENQUEUE_TIMEOUT_MS = 2_000;

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
      await withRedisTimeout(
        this.queueClient.get().add(descriptor.name, data, opts),
        ENQUEUE_TIMEOUT_MS,
        () => new RedisCommandTimeoutError('enqueue', ENQUEUE_TIMEOUT_MS)
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
