import { afterEach, describe, expect, test } from 'bun:test';
import {
  type EventLoopStall,
  enterProcedure,
  httpRouteLabel,
  monitorEventLoopStalls,
} from '../../src/lib/event-loop-stalls';

let stop: (() => void) | undefined;
afterEach(() => stop?.());

const INTERVAL = 20;

/**
 * A monitor on a clock and ticker the test owns (SC-1374). Every reading here
 * is arithmetic on times the test chose, so a loaded machine cannot add a stall
 * or lag: two assertions in this file failed on busy CI agents while they read
 * the real event loop.
 */
function fakeMonitor(readHeapBytes?: () => number, readRssBytes?: () => number) {
  let now = 0;
  let fire = () => {};
  const stalls: EventLoopStall[] = [];
  stop = monitorEventLoopStalls({
    intervalMs: INTERVAL,
    thresholdMs: 50,
    onStall: (s) => stalls.push(s),
    now: () => now,
    every: (tick) => {
      fire = tick;
      return () => {};
    },
    ...(readHeapBytes ? { readHeapBytes } : {}),
    ...(readRssBytes ? { readRssBytes } : {}),
  });
  return {
    stalls,
    /** A tick that fires on time. */
    tick() {
      now += INTERVAL;
      fire();
    },
    /** The thread held for `ms`: time passes and the timer cannot fire. */
    hold(ms: number) {
      now += ms;
    },
  };
}

describe('monitorEventLoopStalls (SC-1322)', () => {
  test('a procedure that holds the thread is named, with the lag it caused', () => {
    const m = fakeMonitor();
    const leave = enterProcedure('dashboard.getOverview');
    m.tick();
    m.hold(150);
    m.tick();
    m.tick();
    leave();

    expect(m.stalls).toHaveLength(1);
    expect(m.stalls[0]?.lagMs).toBe(150);
    expect(m.stalls[0]?.inFlight).toContain('dashboard.getOverview');
  });

  test('one that starts, blocks and settles between two ticks is still named', () => {
    const m = fakeMonitor();
    m.tick();
    const leave = enterProcedure('portfolio.getReturns');
    m.hold(120);
    leave();
    m.tick();

    expect(m.stalls).toHaveLength(1);
    expect(m.stalls[0]?.inFlight).toContain('portfolio.getReturns');
  });

  // The control: procedures awaiting rather than computing produce no stall,
  // so a report is about blocking and not about being slow.
  test('procedures that only wait never register as a stall', () => {
    const m = fakeMonitor();
    const leaveA = enterProcedure('review.listPending');
    const leaveB = enterProcedure('portfolio.hasReturns');
    for (let i = 0; i < 10; i++) m.tick();
    leaveA();
    leaveB();

    expect(m.stalls).toHaveLength(0);
  });

  // A lag just under the threshold is not a stall; one at it is.
  test('the threshold is where a late tick becomes a stall', () => {
    const m = fakeMonitor();
    m.hold(49);
    m.tick();
    expect(m.stalls).toHaveLength(0);
    m.hold(50);
    m.tick();
    expect(m.stalls.map((s) => s.lagMs)).toEqual([50]);
  });

  test('a stall carries the heap at the tick before it and at the late tick', () => {
    let bytes = 300 * 2 ** 20;
    const m = fakeMonitor(() => bytes);
    m.tick();
    bytes = 120 * 2 ** 20; // a collection inside the blocked interval
    m.hold(120);
    m.tick();

    expect(m.stalls).toHaveLength(1);
    expect(m.stalls[0]).toMatchObject({ heapBeforeMb: 300, heapAfterMb: 120 });
  });

  test("a stall carries the process's resident memory, the figure the machine runs out of (SC-1671)", () => {
    const m = fakeMonitor(undefined, () => 640 * 2 ** 20);
    m.tick();
    m.hold(120);
    m.tick();

    expect(m.stalls[0]?.rssMb).toBe(640);
  });

  // The control: a stall with no collection in it does not read as one.
  test('a stall with no collection inside it reports a heap that did not fall', () => {
    let bytes = 100 * 2 ** 20;
    const m = fakeMonitor(() => (bytes += 2 ** 20));
    m.tick();
    m.hold(120);
    m.tick();

    expect(m.stalls).toHaveLength(1);
    expect(m.stalls[0]!.heapAfterMb).toBeGreaterThan(m.stalls[0]!.heapBeforeMb);
  });

  // The one test on the real timer, clock and heap, so the defaults are wired.
  // It asks only whether the stall IT caused was seen: load can add stalls and
  // lengthen lag, and neither changes this answer.
  test('the default timer sees a real block and names what was running', async () => {
    const stalls: EventLoopStall[] = [];
    stop = monitorEventLoopStalls({
      intervalMs: 20,
      thresholdMs: 50,
      onStall: (s) => stalls.push(s),
    });
    const leave = enterProcedure('real.block');
    await new Promise((resolve) => setTimeout(resolve, 30));
    const until = performance.now() + 150;
    while (performance.now() < until) {
      // Holds the thread the way a synchronous computation in a resolver does.
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
    leave();

    const caused = stalls.find((s) => s.inFlight.includes('real.block') && s.lagMs >= 100);
    expect(caused).toBeDefined();
    expect(caused!.heapBeforeMb).toBeGreaterThan(0);
    expect(caused!.heapAfterMb).toBeGreaterThan(0);
  });
});

describe('enterProcedure reports the thread time held while it ran (SC-1369)', () => {
  test('a procedure waiting on I/O was not blocked — the control', () => {
    const m = fakeMonitor();
    const leave = enterProcedure('portfolio.hasReturns');
    for (let i = 0; i < 8; i++) m.tick();
    expect(leave().blockedMs).toBe(0);
  });

  test("a neighbour's CPU is charged to a procedure that was waiting beside it", () => {
    const m = fakeMonitor();
    const leave = enterProcedure('portfolio.hasReturns');
    m.tick();
    m.hold(150);
    m.tick();
    m.tick();
    expect(leave().blockedMs).toBe(150);
  });

  // It exists for the last 20ms of the 150ms late interval, so that is all it
  // can be charged: where in the interval the thread was held is unknown.
  test('a procedure that starts after the block is charged only the time it existed', () => {
    const m = fakeMonitor();
    m.tick();
    m.hold(150);
    const leave = enterProcedure('portfolio.hasReturns');
    m.tick();
    m.tick();
    expect(leave().blockedMs).toBe(20);
  });
});

describe('blocked time has a 5ms floor per tick (SC-1671)', () => {
  // Measured 2026-10-10: a procedure that only slept read 67-71ms of "blocked"
  // per second on a loaded Mac, and prod getReturns 24-35ms/s with no stall,
  // because every tick's sub-millisecond lateness was summed for the whole call.
  test('timer jitter below the floor is not blocked time', () => {
    const m = fakeMonitor();
    const leave = enterProcedure('portfolio.getReturns');
    for (let i = 0; i < 50; i++) {
      m.hold(4);
      m.tick();
    }
    expect(leave().blockedMs).toBe(0);
  });

  test('a late tick at the floor is counted in full', () => {
    const m = fakeMonitor();
    const leave = enterProcedure('portfolio.getReturns');
    m.tick();
    m.hold(5);
    m.tick();
    expect(leave().blockedMs).toBe(5);
  });

  test('the old unfloored sum is still reported, as lagSumMs', () => {
    const m = fakeMonitor();
    const leave = enterProcedure('portfolio.getReturns');
    m.tick();
    m.hold(4);
    m.tick();
    m.hold(30);
    m.tick();
    expect(leave()).toEqual({ blockedMs: 30, lagSumMs: 34 });
  });
});

describe('httpRouteLabel (SC-1671)', () => {
  // The stall line named tRPC procedures only, so on 2026-10-09 three trivial
  // procedures were listed in flight while whatever held the thread was not.
  test('a route outside tRPC is named by method and path', () => {
    expect(httpRouteLabel('POST', '/mcp')).toBe('http POST /mcp');
    expect(httpRouteLabel('GET', '/billing/status')).toBe('http GET /billing/status');
  });

  test('a tRPC request is one label whatever it batches: its procedures name themselves', () => {
    expect(httpRouteLabel('GET', '/trpc/users.getCurrent,users.getBaseCurrency')).toBe(
      'http GET /trpc'
    );
    expect(httpRouteLabel('POST', '/trpc/users.appOpened')).toBe('http POST /trpc');
  });

  test('ids in a path collapse, so the label set stays bounded', () => {
    expect(httpRouteLabel('GET', '/documents/0b7db385-c0de-4000-8000-00000000abcd/file')).toBe(
      'http GET /documents/:id/file'
    );
    expect(httpRouteLabel('GET', '/exports/12345')).toBe('http GET /exports/:id');
  });

  test('a request registered under its label is named in the stall it sat through', () => {
    const m = fakeMonitor();
    const leave = enterProcedure(httpRouteLabel('POST', '/mcp'));
    m.tick();
    m.hold(200);
    m.tick();
    leave();
    expect(m.stalls[0]?.inFlight).toEqual(['http POST /mcp']);
  });
});
