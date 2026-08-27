import { describe, expect, test } from 'bun:test';

/**
 * SC-751. `@sentry/node`'s default HTTP instrumentation patches `node:http`.
 * Every service here is served by `Bun.serve`, which does not go through it —
 * so nothing produces a server transaction on its own, and a span has to be
 * asked for explicitly. `withSpan` is that ask.
 *
 * WHY THIS TEST DRIVES THE REAL SDK. The claim is about what the SDK
 * TRANSMITS, and every cheaper way of checking it inspects our own code
 * instead. A hand-built fixture would test our model of `@sentry/node`, which
 * is exactly the thing that was wrong: the api ran tracing in production for
 * months, ingesting real data, while recording no tRPC route at all — because
 * reading the config says tracing is on and says nothing about what reaches it.
 *
 * The reddening input is the mistake, not the correction: this goes red if
 * someone concludes the SDK auto-instruments the server and removes the
 * explicit span, and it goes red if `Bun.serve` ever gains instrumentation
 * that makes the manual span redundant. Both are things a reader should be
 * told about rather than discover in a dashboard.
 *
 * The fixture runs in a SUBPROCESS because `initSentry` sets a module-level
 * flag and `Sentry.init` registers global OpenTelemetry state, and `bun test`
 * runs every file in one process. Initializing a real client in-suite would
 * leave every later file with a Sentry that actually transmits.
 */

const FIXTURE = 'packages/infra/logging/tests/fixtures/span-over-bun-serve.fixture.ts';

type FixtureResult = {
  iterations: number;
  armA_bunServeTransactions: number;
  armB_withSpanTransactions: number;
  armB_names: string[];
  armB_ops: string[];
};

async function runFixture(): Promise<FixtureResult> {
  const proc = Bun.spawn(['bun', FIXTURE], {
    cwd: process.cwd(),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  const line = stdout.split('\n').find((l) => l.startsWith('SC751_RESULT '));
  if (exitCode !== 0 || !line) {
    // A killed or crashed subprocess returns empty output, and empty output
    // reads downstream as "nothing was transmitted" — which is arm A's PASSING
    // answer. Refuse rather than let a non-result be consumed as a verdict.
    throw new Error(
      `fixture produced no verdict (exit ${exitCode}).\nstdout: ${stdout}\nstderr: ${stderr}`
    );
  }
  return JSON.parse(line.slice('SC751_RESULT '.length)) as FixtureResult;
}

describe('a Sentry span over Bun.serve', () => {
  // One subprocess, both arms, because they must share one initialized client:
  // arm B is what proves arm B's zero would have been visible.
  let result: FixtureResult;

  test('the fixture reports a verdict for both arms', async () => {
    result = await runFixture();
    expect(result.iterations).toBeGreaterThan(0);
  });

  test('an uninstrumented Bun.serve request transmits NO transaction', () => {
    // The population, so the zero is a measurement rather than an abstention:
    // the same client, in the same process, transmitted arm B's transactions.
    expect(result.armB_withSpanTransactions).toBeGreaterThan(0);
    expect(result.armA_bunServeTransactions).toBe(0);
  });

  test('an explicit withSpan call transmits a transaction, named and op-tagged', () => {
    expect(result.armB_withSpanTransactions).toBeGreaterThan(0);
    expect(result.armB_names).toEqual(['trpc/sc751.probe']);
    expect(result.armB_ops).toEqual(['rpc.server']);
  });
});
