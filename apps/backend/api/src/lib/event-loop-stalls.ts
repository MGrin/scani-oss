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
  /** The process's resident memory at the late tick: what the machine runs out of (SC-1671). */
  rssMb: number;
}

const mb = (bytes: number) => Math.round(bytes / 2 ** 20);

interface InFlightEntry {
  path: string;
  startedAt: number;
  blockedMs: number;
  lagSumMs: number;
}

/**
 * The thread time a procedure saw held while it was in flight (SC-1671).
 *
 * `blockedMs` counts a late tick only when it was at least
 * `BLOCKED_FLOOR_MS` late. Every tick on a shared-cpu machine is a fraction
 * of a millisecond late, and summing that over a long call reported waiting
 * as blocking: a procedure that only slept read 67-71ms per second on a
 * loaded Mac, and prod getReturns 24-35ms/s with no stall (2026-10-10). So
 * "getReturns blocks the thread under 200ms" means under 200ms of late ticks
 * of 5ms or more, not under 200ms of timer jitter.
 *
 * `lagSumMs` is the old, unfloored sum, kept for one release so a dashboard
 * reading `loopBlockedMs` sees its meaning change beside the old figure
 * instead of silently. Remove it in the release after SC-1671 ships.
 */
export interface ProcedureLoopTime {
  blockedMs: number;
  lagSumMs: number;
}

const BLOCKED_FLOOR_MS = 5;

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
 * connection, the network or a query. Accumulated from every tick at least
 * `BLOCKED_FLOOR_MS` late rather than only from those past the stall
 * threshold, because a run of 20–40ms neighbours never logs a stall and
 * still adds up. See `ProcedureLoopTime` for why there is a floor at all.
 */
export function enterProcedure(path: string): () => ProcedureLoopTime {
  const id = nextId++;
  const entry: InFlightEntry = { path, startedAt: clock(), blockedMs: 0, lagSumMs: 0 };
  inFlight.set(id, entry);
  return () => {
    inFlight.delete(id);
    settled.add(path);
    return { blockedMs: Math.round(entry.blockedMs), lagSumMs: Math.round(entry.lagSumMs) };
  };
}

const ID_SEGMENT = /^(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/**
 * What an HTTP request is registered under, so a stall names work outside tRPC
 * too (SC-1671): three trivial procedures were listed in flight on 2026-10-09
 * while whatever held the thread was not on the list. A tRPC request is one
 * label, because its procedures name themselves; what it adds is the request
 * still waiting for its procedure to start. Ids collapse so the set of labels
 * stays as small as the set of routes.
 */
export function httpRouteLabel(method: string, pathname: string): string {
  if (pathname === '/trpc' || pathname.startsWith('/trpc/')) return `http ${method} /trpc`;
  const path = pathname
    .split('/')
    .map((segment) => (ID_SEGMENT.test(segment) ? ':id' : segment))
    .join('/');
  return `http ${method} ${path}`;
}

export function monitorEventLoopStalls(options: {
  intervalMs: number;
  thresholdMs: number;
  onStall: (stall: EventLoopStall) => void;
  readHeapBytes?: () => number;
  readRssBytes?: () => number;
  now?: () => number;
  every?: (tick: () => void, intervalMs: number) => () => void;
}): () => void {
  const { intervalMs, thresholdMs, onStall } = options;
  const readHeapBytes = options.readHeapBytes ?? (() => process.memoryUsage().heapUsed);
  const readRssBytes = options.readRssBytes ?? (() => process.memoryUsage().rss);
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
        const charged = Math.min(lagMs, now - entry.startedAt);
        entry.lagSumMs += charged;
        if (lagMs >= BLOCKED_FLOOR_MS) entry.blockedMs += charged;
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
        rssMb: mb(readRssBytes()),
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
