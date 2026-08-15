import { describe, expect, test } from 'bun:test';
import { DataProviderHealthMonitor } from '../src/health-monitor';
import type { ProbeResult } from '../src/health-probe';

// Sentry SCANI-BACKEND-7 verbatim: `probeDataProvider` exhausts its three
// 3s attempts and reports the last AbortController message.
const ABORTED: ProbeResult = {
  ok: false,
  url: 'https://data-provider.internal',
  error: 'The operation was aborted.',
  attempts: 3,
};
const OK: ProbeResult = { ok: true, url: 'https://data-provider.internal', attempts: 1 };

function makeMonitor(
  script: ProbeResult[],
  opts: { failuresBeforeAlert?: number; initiallyReachable?: boolean } = {}
) {
  const outages: number[] = [];
  const cycles: number[] = [];
  const recoveries: Array<{ failedCycles: number; wasReported: boolean }> = [];
  let i = 0;

  const monitor = new DataProviderHealthMonitor({
    failuresBeforeAlert: opts.failuresBeforeAlert ?? 5,
    initiallyReachable: opts.initiallyReachable,
    probe: async () => script[Math.min(i++, script.length - 1)] as ProbeResult,
    onOutage: (info) => outages.push(info.consecutiveFailures),
    onCycleFailed: (info) => cycles.push(info.consecutiveFailures),
    onRecovered: (info) =>
      recoveries.push({ failedCycles: info.failedCycles, wasReported: info.wasReported }),
  });

  return {
    monitor,
    outages,
    cycles,
    recoveries,
    async run(n: number) {
      for (let t = 0; t < n; t++) await monitor.tick();
    },
  };
}

describe('DataProviderHealthMonitor', () => {
  test('a deploy cutover does not raise an outage', async () => {
    // The actual SCANI-BACKEND-7 shape: the single data-provider machine
    // is replaced, a cycle or two abort, then it comes back. Three events
    // in three weeks were all exactly this, and all three paged us.
    const { monitor, outages, cycles, recoveries, run } = makeMonitor([ABORTED, ABORTED, OK]);

    await run(3);

    expect(outages).toEqual([]);
    // Not invisible — every failed cycle is still surfaced to the caller.
    expect(cycles).toEqual([1, 2]);
    expect(recoveries).toEqual([{ failedCycles: 2, wasReported: false }]);
    expect(monitor.reachable).toBe(true);
  });

  test('threshold 1 reproduces the old behaviour — the same cutover pages us', async () => {
    // The delta, pinned. `failuresBeforeAlert: 1` is exactly what the api
    // and worker did inline, and against the identical deploy script it
    // raises the outage that produced SCANI-BACKEND-7. If anyone lowers
    // the default back to 1, the test above starts failing and this one
    // says why.
    const { outages, run } = makeMonitor([ABORTED, ABORTED, OK], { failuresBeforeAlert: 1 });

    await run(3);

    expect(outages).toEqual([1]);
  });

  test('a sustained outage is reported exactly once, at the threshold', async () => {
    const { monitor, outages, run } = makeMonitor([ABORTED], { failuresBeforeAlert: 5 });

    await run(4);
    expect(outages).toEqual([]);

    await run(1);
    expect(outages).toEqual([5]);

    // Still down ten minutes later: one incident, one alert.
    await run(10);
    expect(outages).toEqual([5]);
    expect(monitor.reachable).toBe(false);
  });

  test('a second outage in the same process is still reported', async () => {
    // The api latched `everReportedDown = true` forever, so once a process
    // had reported once it went permanently deaf — a genuine outage hours
    // later was never surfaced. The latch has to clear on recovery.
    const script = [
      ...Array<ProbeResult>(5).fill(ABORTED),
      OK,
      ...Array<ProbeResult>(5).fill(ABORTED),
    ];
    const { outages, recoveries, run } = makeMonitor(script, { failuresBeforeAlert: 5 });

    await run(11);

    expect(outages).toEqual([5, 5]);
    expect(recoveries).toEqual([{ failedCycles: 5, wasReported: true }]);
  });

  test('the failure count resets, so flapping never accumulates to an alert', async () => {
    // Alternating down/up is a deploy or a blip, not an outage. A counter
    // that only ever incremented would eventually cross the threshold and
    // report a data-provider that is, in fact, up.
    const { outages, run } = makeMonitor(
      [ABORTED, OK, ABORTED, OK, ABORTED, OK, ABORTED, OK, ABORTED, OK],
      { failuresBeforeAlert: 5 }
    );

    await run(10);

    expect(outages).toEqual([]);
  });

  test('a boot-time failure counts as the first cycle, not a separate alert', async () => {
    // An api that boots while the data-provider is mid-deploy is the same
    // transient seen from a different angle, so it goes through the same
    // threshold rather than capturing immediately.
    const { outages, run } = makeMonitor([ABORTED], {
      initiallyReachable: false,
      failuresBeforeAlert: 5,
    });

    expect(outages).toEqual([]);

    // Seeded at 1, so four more cycles reach the threshold.
    await run(3);
    expect(outages).toEqual([]);

    await run(1);
    expect(outages).toEqual([5]);
  });

  test('a boot-time failure that clears immediately reports nothing', async () => {
    const { monitor, outages, recoveries, run } = makeMonitor([OK], {
      initiallyReachable: false,
    });

    await run(1);

    expect(outages).toEqual([]);
    expect(recoveries).toEqual([{ failedCycles: 1, wasReported: false }]);
    expect(monitor.reachable).toBe(true);
  });
});
