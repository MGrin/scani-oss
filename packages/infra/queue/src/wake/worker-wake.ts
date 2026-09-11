import { createHmac, timingSafeEqual } from 'node:crypto';
import { createComponentLogger } from '@scani/logging';
import type { Worker } from 'bullmq';
import { Service } from 'typedi';

const log = createComponentLogger('queue:worker-wake');

/**
 * SC-1144. A worker on a scale-to-zero Postgres loses its LISTEN connection
 * when the compute suspends, and re-establishes it only when its idle timer
 * fires — up to 600s later on Neon (SC-963). A job a user enqueues in that
 * window has nobody to NOTIFY. So the api pings the worker after every user
 * enqueue, and the worker cuts its wait short: it polls once, then listens
 * again. The ping carries no job, and nothing depends on it arriving — a lost
 * ping costs exactly the latency there was before it existed.
 *
 * Scheduled jobs are enqueued by the worker itself and never ping, so an idle
 * system still leaves the database alone long enough to suspend. And a ping
 * cannot wake a sleeping compute on its own: it follows an enqueue, which
 * already did.
 */

export const WORKER_WAKE_PATH = '/wake';

/**
 * How long the api waits for the worker to answer. It runs after an enqueue a
 * user is waiting on, detached from it, so this bounds sockets rather than a
 * spinner — a worker that cannot answer on a private network in 2s is not
 * going to.
 */
export const WORKER_WAKE_TIMEOUT_MS = 2_000;

// A replayed wake makes the worker poll once, which is harmless; the skew
// bound only stops a captured signature being usable indefinitely.
const MAX_SKEW_MS = 5_000;
const HMAC_HEADER = 'x-wake-hmac';
const TIMESTAMP_HEADER = 'x-wake-timestamp';

function digest(secret: string, timestamp: string): string {
  return createHmac('sha256', secret)
    .update(`POST\n${WORKER_WAKE_PATH}\n${timestamp}`)
    .digest('hex');
}

export function signWorkerWake(secret: string, timestamp: number): Record<string, string> {
  return {
    [HMAC_HEADER]: digest(secret, String(timestamp)),
    [TIMESTAMP_HEADER]: String(timestamp),
  };
}

export function verifyWorkerWake(secret: string, headers: Headers, now = Date.now()): boolean {
  const hmac = headers.get(HMAC_HEADER);
  const timestamp = headers.get(TIMESTAMP_HEADER);
  if (!hmac || !timestamp) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > MAX_SKEW_MS) return false;
  const expected = Buffer.from(digest(secret, timestamp), 'hex');
  const given = Buffer.from(hmac, 'hex');
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/**
 * End an idle worker's blocking wait now, so it polls the queue and then
 * re-establishes its LISTEN. A no-op when the worker is not waiting — it is
 * then already about to poll.
 *
 * `cancelWait` is private to BullMQ's Postgres backend; it is what the
 * backend's own `disconnect()` calls to interrupt a wait. The SC-1144 arms in
 * `idle-worker-wakeups.test.ts` drive it for real, so a BullMQ upgrade that
 * renames it goes red there rather than silently leaving the ping inert.
 */
export function interruptIdleWait(worker: Worker<any, any, string, any>): void {
  (worker.backend as { cancelWait?: () => void }).cancelWait?.();
}

export type WorkerWakeOutcome = 'woken' | 'unconfigured' | 'failed';

export interface WorkerWakeClientConfig {
  /** The worker's wake origin, e.g. `http://worker:8081`. */
  url?: string;
  /** `JOBS_HMAC_SECRET`, shared with the worker. */
  secret?: string;
}

/**
 * The api's side. Unconfigured is the self-host default and makes `ping()` a
 * no-op: a single-machine stack's Postgres never suspends, so its LISTEN is
 * never down and there is nothing to wake.
 */
@Service()
export class WorkerWakeClient {
  private endpoint: string | null = null;
  private secret: string | null = null;

  configure(config: WorkerWakeClientConfig): void {
    if (config.url && !config.secret) {
      log.warn({}, 'Worker wake URL set without JOBS_HMAC_SECRET — the api will not ping');
    }
    this.endpoint = config.url && config.secret ? new URL(WORKER_WAKE_PATH, config.url).href : null;
    this.secret = config.secret ?? null;
  }

  /** Never rejects, and settles within {@link WORKER_WAKE_TIMEOUT_MS}. */
  async ping(): Promise<WorkerWakeOutcome> {
    if (!this.endpoint || !this.secret) return 'unconfigured';
    try {
      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers: signWorkerWake(this.secret, Date.now()),
        signal: AbortSignal.timeout(WORKER_WAKE_TIMEOUT_MS),
      });
      if (res.status === 204) return 'woken';
      log.warn({ status: res.status }, 'Worker wake refused — the job starts at the next poll');
    } catch (err) {
      log.warn(
        { error: err instanceof Error ? err.message : String(err) },
        'Worker wake failed — the job starts at the next poll'
      );
    }
    return 'failed';
  }
}

export interface WorkerWakeServerOptions {
  port: number;
  /** `::` on Fly, where the api reaches the worker over IPv6-only 6PN. */
  hostname: string;
  secret: string;
  onWake: () => void;
}

/** The worker's side: one signed route, nothing else. */
export function serveWorkerWake(opts: WorkerWakeServerOptions): { port: number; stop(): void } {
  const server = Bun.serve({
    port: opts.port,
    hostname: opts.hostname,
    fetch(req) {
      const { pathname } = new URL(req.url);
      if (req.method !== 'POST' || pathname !== WORKER_WAKE_PATH) {
        return new Response(null, { status: 404 });
      }
      if (!verifyWorkerWake(opts.secret, req.headers)) {
        return new Response(null, { status: 401 });
      }
      opts.onWake();
      return new Response(null, { status: 204 });
    },
  });
  return {
    port: server.port ?? opts.port,
    stop: () => {
      server.stop(true);
    },
  };
}
