import type { ReturnsOutcome, ReturnsRequest } from '@scani/domain/services';
import { Service } from 'typedi';

/**
 * `getReturns` runs in ONE worker thread (SC-1671). On the API's own event loop
 * a Home load's three windows held every other request for 6 s on production,
 * and on 2026-10-09 for minutes. The main thread keeps the result cache and
 * only copies a result back (at most ~140 KB).
 *
 * That thread must not be able to take the API down instead, so: one worker,
 * a bounded queue that refuses rather than grows, a timeout that replaces a
 * worker stuck in a calculation, and a heap cap the worker enforces on itself
 * while it calculates (`returns-worker.ts`).
 *
 * This file and the worker sit beside `index.ts` on purpose: the URL below
 * resolves the same from source and inside the compiled binary only when the
 * module that starts the worker is at the bundle's root (measured 2026-10-10).
 */

export interface WorkerLike {
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: unknown): void;
  terminate(): void;
}

type Reply =
  | { id: number; ok: true; outcome: ReturnsOutcome }
  | { id: number; ok: false; error: string }
  | { kind: 'heap-cap'; heapMb: number }
  | { kind: 'heap'; heapMb: number };

interface Pending {
  resolve: (outcome: ReturnsOutcome) => void;
  reject: (error: Error) => void;
}

export interface ReturnsPoolStats {
  spawns: number;
  pending: number;
  workerHeapMb: number | null;
}

/**
 * The worker's heap budget. The machine has 962 MB; the main thread's peak
 * after #2341 was 575 MB, and 25% headroom puts the ceiling at 722 MB.
 */
const DEFAULT_HEAP_CAP_MB = 300;

function spawnWorker(): WorkerLike {
  return new Worker(new URL('./returns-worker.ts', import.meta.url)) as unknown as WorkerLike;
}

export class ReturnsWorkerPool {
  private worker: WorkerLike | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private spawns = 0;
  private workerHeapMb: number | null = null;
  private readonly spawn: () => WorkerLike;
  private readonly maxPending: number;
  private readonly timeoutMs: number;
  private readonly heapCapMb: number;

  constructor(options: {
    spawn?: () => WorkerLike;
    maxPending: number;
    timeoutMs: number;
    /** Sent with every job: a worker does not see this thread's later env changes. */
    heapCapMb?: number;
  }) {
    this.spawn = options.spawn ?? spawnWorker;
    this.maxPending = options.maxPending;
    this.timeoutMs = options.timeoutMs;
    this.heapCapMb = options.heapCapMb ?? DEFAULT_HEAP_CAP_MB;
  }

  run(request: ReturnsRequest, dataKey: string): Promise<ReturnsOutcome> {
    if (this.pending.size >= this.maxPending) {
      return Promise.reject(new Error('returns queue full'));
    }
    const worker = this.current();
    const id = this.nextId++;
    return new Promise<ReturnsOutcome>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.armTimeout();
      worker.postMessage({ id, request, dataKey, heapCapMb: this.heapCapMb });
    });
  }

  stats(): ReturnsPoolStats {
    return { spawns: this.spawns, pending: this.pending.size, workerHeapMb: this.workerHeapMb };
  }

  close(): void {
    this.replace(new Error('returns pool closed'));
  }

  private current(): WorkerLike {
    if (this.worker) return this.worker;
    const worker = this.spawn();
    this.spawns += 1;
    worker.onmessage = (event) => this.onReply(worker, event.data as Reply);
    worker.onerror = (event) => {
      if (worker === this.worker)
        this.replace(new Error(`returns worker failed: ${event.message}`));
    };
    this.worker = worker;
    return worker;
  }

  private onReply(worker: WorkerLike, reply: Reply): void {
    if (worker !== this.worker) return;
    if ('kind' in reply) {
      this.workerHeapMb = reply.heapMb;
      if (reply.kind === 'heap-cap') this.replace(new Error('returns worker over its heap cap'));
      return;
    }
    const call = this.pending.get(reply.id);
    if (!call) return;
    this.pending.delete(reply.id);
    if (reply.ok) call.resolve(reply.outcome);
    else call.reject(new Error(reply.error));
    this.armTimeout();
  }

  /** One timer for the oldest work in flight: it restarts on every answer. */
  private armTimeout(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.pending.size === 0) return;
    this.timer = setTimeout(() => this.replace(new Error('returns timed out')), this.timeoutMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** Fail everything in flight and drop the worker; the next call starts one. */
  private replace(error: Error): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const worker = this.worker;
    this.worker = null;
    worker?.terminate();
    const calls = [...this.pending.values()];
    this.pending.clear();
    for (const call of calls) call.reject(error);
  }
}

/**
 * What the router calls. Production runs returns off the event loop; a test
 * replaces this in the container with a runner that calls the engine inline.
 */
@Service()
export class ReturnsRunner {
  private readonly pool = new ReturnsWorkerPool({ maxPending: 8, timeoutMs: 30_000 });

  run(request: ReturnsRequest, dataKey: string): Promise<ReturnsOutcome> {
    return this.pool.run(request, dataKey);
  }

  stats(): ReturnsPoolStats {
    return this.pool.stats();
  }
}
