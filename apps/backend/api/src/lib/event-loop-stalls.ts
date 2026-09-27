export interface EventLoopStall {
  lagMs: number;
  /** Everything running at any point in the late interval — the blocker is one of these. */
  inFlight: string[];
  /**
   * Heap in use at the tick before the stall and at the late tick. A procedure
   * that is usually fast and sometimes blocks for 700ms reads like a
   * collection rather than like code; a heap that FELL across the interval
   * says a collection ran inside it, which no procedure name can say.
   */
  heapBeforeMb: number;
  heapAfterMb: number;
}

const mb = (bytes: number) => Math.round(bytes / 2 ** 20);

interface InFlightEntry {
  path: string;
  startedAt: number;
  blockedMs: number;
}

const inFlight = new Map<number, InFlightEntry>();
// Settled since the last tick: a procedure can start, block and finish
// between two ticks, and would otherwise be in neither view of the interval.
const settled = new Set<string>();
let nextId = 0;
// The monitor's clock, shared with `enterProcedure` so a start time and a tick
// are read off the same timeline. Injectable because a test that reads real lag
// reads its machine's load as well (SC-1374).
let clock: () => number = () => performance.now();

/**
 * Registers a running procedure. The returned function settles it and answers
 * how long the thread was held by ANYONE while it was in flight (SC-1369).
 *
 * Beside the procedure's own duration that separates the two ways a cheap
 * procedure is slow: blocked time close to the duration is CPU contention on
 * the one thread, and blocked time near zero is waiting on I/O — a pool
 * connection, the network or a query. Accumulated from every late tick rather
 * than only from those past the stall threshold, because a run of 20–40ms
 * neighbours never logs a stall and still adds up.
 */
export function enterProcedure(path: string): () => number {
  const id = nextId++;
  const entry: InFlightEntry = { path, startedAt: clock(), blockedMs: 0 };
  inFlight.set(id, entry);
  return () => {
    inFlight.delete(id);
    settled.add(path);
    return Math.round(entry.blockedMs);
  };
}

export function monitorEventLoopStalls(options: {
  intervalMs: number;
  thresholdMs: number;
  onStall: (stall: EventLoopStall) => void;
  readHeapBytes?: () => number;
  now?: () => number;
  every?: (tick: () => void, intervalMs: number) => () => void;
}): () => void {
  const { intervalMs, thresholdMs, onStall } = options;
  const readHeapBytes = options.readHeapBytes ?? (() => process.memoryUsage().heapUsed);
  const every = options.every ?? everyInterval;
  if (options.now) clock = options.now;
  let last = clock();
  let heapLastTick = readHeapBytes();
  // A procedure that blocked and finished inside one interval is gone from the
  // map by the time the late tick runs, so the previous tick's view is kept.
  let seenLastTick = new Set([...inFlight.values()].map((e) => e.path));

  const cancel = every(() => {
    const now = clock();
    const lagMs = now - last - intervalMs;
    if (lagMs > 0) {
      // Where in the interval the thread was held is unknown, so a procedure
      // that started inside it is charged at most the time it has existed.
      for (const entry of inFlight.values()) {
        entry.blockedMs += Math.min(lagMs, now - entry.startedAt);
      }
    }
    const seenNow = new Set([...inFlight.values()].map((e) => e.path));
    const heapNow = readHeapBytes();
    if (lagMs >= thresholdMs) {
      onStall({
        lagMs: Math.round(lagMs),
        inFlight: [...new Set([...seenLastTick, ...settled, ...seenNow])],
        heapBeforeMb: mb(heapLastTick),
        heapAfterMb: mb(heapNow),
      });
    }
    heapLastTick = heapNow;
    last = now;
    seenLastTick = seenNow;
    settled.clear();
  }, intervalMs);

  return () => {
    cancel();
    clock = () => performance.now();
  };
}

function everyInterval(tick: () => void, intervalMs: number): () => void {
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
