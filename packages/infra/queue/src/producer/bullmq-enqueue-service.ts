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
 * **The bound covers the WHOLE enqueue, not just `queue.add`, and that is the
 * point rather than a detail.** SC-846 added two more store round-trips —
 * `evictFinishedNamesake`'s `getJob`/`remove` before the add, and
 * `assertWorkWasQueued`'s `getJob` after it. Bounding only the middle one puts
 * an unbounded await *first*, so against an unreachable store the sequence
 * hangs before the deadline is ever reached and the `catch` below never runs:
 * exactly the state this constant exists to prevent, reintroduced one call
 * earlier. Measured 2026-08-31 against the ordering this replaces, with a
 * fake whose `add` resolves instantly and whose `getJob` never settles —
 * `add()` was still pending at 15003ms.
 *
 * **Widening it to three round-trips does not need a bigger number**, because
 * only the first pays for establishing the connection: the pool is warm for
 * the two that follow, and a warm round trip measured p50 76ms / p99 1238ms
 * (n=200). So the worst realistic path is one cold call plus two warm ones,
 * against a budget sized for a single cold one — the headroom the paragraph
 * above argues for is unchanged.
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
      const queue = this.queueClient.get();
      await withDeadline(
        (async () => {
          await this.evictFinishedNamesake(queue, jobId, descriptor.name, data.userId);
          await queue.add(descriptor.name, data, opts);
          await this.assertWorkWasQueued(queue, jobId, data.requestId, descriptor.name);
        })(),
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

  /**
   * Delete a FINISHED job already sitting on `jobId`, so the add below is not
   * silently discarded (SC-846).
   *
   * BullMQ's Postgres `add_job` ends in `ON CONFLICT (queue, id) DO NOTHING`,
   * and **both the `pg_notify` and the `added` event sit inside the
   * `IF v_inserted` branch while the function returns the id regardless**. So
   * an add onto an occupied id creates nothing, queues nothing, raises
   * nothing, and hands the caller back an id that looks like a receipt.
   *
   * A deterministic `jobId` is deliberate — `REFRESH_ACCOUNT_BALANCE` leaves
   * `requestId` out of its id precisely so a second click collapses onto the
   * in-flight refresh, which is correct. The defect is that `ON CONFLICT` has
   * no notion of job STATE, so "collapse onto the in-flight job" also means
   * "collapse onto a job that finished days ago" — and retention guarantees
   * one is there to collapse onto.
   *
   * **Retention is what makes it permanent, and it is NOT only about
   * failures.** Measured on production 2026-08-29: the row wedging the
   * reported account was `completed`, retained by `removeOnComplete: 50`.
   * A successful refresh wedges the button exactly as a failed one does, so
   * dropping `removeOnFail` to 0 would have fixed nothing.
   *
   * Evicting only a FINISHED namesake is what keeps the intended dedup:
   * a `waiting`/`active`/`delayed` row is real work in progress and is left
   * alone, so rapid clicks still collapse onto one job.
   */
  private async evictFinishedNamesake(
    queue: {
      getJob(id: string): Promise<{ finishedOn?: number; remove(): Promise<unknown> } | undefined>;
    },
    jobId: string,
    jobName: string,
    userId: string
  ): Promise<void> {
    const existing = await queue.getJob(jobId);
    if (!existing || existing.finishedOn == null) return;
    await existing.remove();
    logger.info(
      { jobId, jobName, userId, finishedOn: existing.finishedOn },
      'Evicted a finished job squatting on a deterministic jobId'
    );
  }

  /**
   * Refuse to report success when the add queued nothing (SC-846).
   *
   * `evictFinishedNamesake` closes the reported hole; this closes the class.
   * The eviction is a read followed by a write, so a job that finishes inside
   * that window is still collapsed onto — and any descriptor written later
   * with a deterministic id inherits the same hazard without anyone noticing.
   * The invariant an enqueue owes its caller is not "the insert did not throw"
   * but **"live work exists under this id"**, and that is what is checked here.
   *
   * The discriminator is whose `requestId` the landed row carries, NOT whether
   * it is finished: a fast job can legitimately complete before this read, and
   * treating that as a collapse would reject a perfectly good enqueue. Every
   * click mints a fresh `crypto.randomUUID()`, so a row carrying somebody
   * else's `requestId` and already finished is unambiguously not our work.
   *
   * A missing row is a success: `removeOnComplete: 0` deletes a job the moment
   * it finishes, so "gone" and "never inserted" are not distinguishable here
   * and the former is by far the likelier. The collapse this catches always
   * leaves the squatter behind — that is the whole reason it is in the way.
   */
  private async assertWorkWasQueued(
    queue: { getJob(id: string): Promise<{ finishedOn?: number; data?: unknown } | undefined> },
    jobId: string,
    requestId: string,
    jobName: string
  ): Promise<void> {
    const landed = await queue.getJob(jobId);
    if (!landed || landed.finishedOn == null) return;
    const landedRequestId = (landed.data as { requestId?: string } | undefined)?.requestId;
    if (landedRequestId === requestId) return;
    throw new Error(
      `Enqueue of ${jobName} collapsed onto a finished job holding the same id (${jobId}) — no work was queued`
    );
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
