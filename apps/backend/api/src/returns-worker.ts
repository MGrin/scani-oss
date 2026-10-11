import 'reflect-metadata';
import '@scani/domain/repositories';
import '@scani/domain/services';
import type { ReturnsRequest } from '@scani/domain/services';
import { ReturnsService, ReturnsSharedLoads } from '@scani/domain/services';
import { Container } from 'typedi';
import { LruCache } from './lib/lru-cache';

/**
 * The worker thread `returns-pool.ts` starts (SC-1671): it computes returns
 * off the API's event loop, with its own container and database pool.
 *
 * It caps its own heap while it calculates. A worker heap is the worker's own
 * (measured: 298 MB here, 0 on the main thread), but terminating a worker does
 * not hand its memory back at once, so the cap has to stop growth, not clean
 * up after it. Over the cap it says so and exits; the pool fails the calls in
 * flight and starts a fresh worker for the next.
 */

declare var self: Worker;

// Set by the pool with each job; the interval check uses the latest.
let heapCapMb = Number.POSITIVE_INFINITY;
const HEAP_CHECK_MS = 250;
const MB = 1048576;

// The loads a user's windows share, per data version: the version is in the
// key, so a write starts a fresh set (`lib/returns-cache.ts`).
const sharedLoads = new LruCache<string, ReturnsSharedLoads>({
  maxEntries: 200,
  ttlMs: 10 * 60_000,
});

function loadsFor(dataKey: string): ReturnsSharedLoads {
  const known = sharedLoads.get(dataKey);
  if (known) return known;
  const fresh = new ReturnsSharedLoads();
  sharedLoads.set(dataKey, fresh);
  return fresh;
}

function overCap(): boolean {
  const heapMb = Math.round(process.memoryUsage().heapUsed / MB);
  if (heapMb <= heapCapMb) return false;
  self.postMessage({ kind: 'heap-cap', heapMb });
  process.exit(1);
  return true;
}

setInterval(overCap, HEAP_CHECK_MS);

interface Job {
  id: number;
  request: ReturnsRequest;
  dataKey: string;
  heapCapMb: number;
}

async function handle({ id, request, dataKey, heapCapMb: cap }: Job): Promise<void> {
  heapCapMb = cap;
  if (overCap()) return;
  try {
    const outcome = await Container.get(ReturnsService).compute(request, {
      shared: loadsFor(dataKey),
    });
    self.postMessage({ id, ok: true, outcome });
  } catch (error) {
    self.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  self.postMessage({ kind: 'heap', heapMb: Math.round(process.memoryUsage().heapUsed / MB) });
}

// One calculation at a time, so the heap holds one calculation and the shared
// loads, never a calculation per call waiting: the windows of a Home load
// still share their loads, the second and third finding them already read.
let queue: Promise<void> = Promise.resolve();
self.onmessage = (event: MessageEvent) => {
  const job = event.data as Job;
  queue = queue.then(() => handle(job));
};
