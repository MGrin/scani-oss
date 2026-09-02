import { describe, expect, test } from 'bun:test';

/**
 * SC-822. A deployed worker reported errors normally and not one performance
 * span for a month. Error capture working is what makes that a finding rather
 * than a guess: the SDK was wired and the DSN reached ingest. Nothing produced
 * a span because nothing could — a BullMQ consumer is not an HTTP server, so
 * the default integrations that patch `node:http` have no transport to patch,
 * and no call site asked for a span by hand.
 *
 * WHY THIS TEST DRIVES THE REAL SDK, and it is SC-751's reasoning rather than a
 * new one: the claim is about what the SDK TRANSMITS. Every cheaper check
 * inspects our own code instead, and our own code is exactly what read as
 * correct for thirty days while the project recorded nothing.
 *
 * The reddening input is the mistake, not the correction. It goes red if
 * dispatch stops asking for a span, if the span's name stops being the bounded
 * `job.name` — a span named per execution is unaggregatable and would silently
 * make the dashboard useless again — or if the op or source drift off the
 * queue-consumer convention Sentry groups on.
 *
 * The fixture runs in a SUBPROCESS because `initSentry` sets a module-level
 * flag and `Sentry.init` registers global OpenTelemetry state, and `bun test`
 * runs every file in one process.
 */

const FIXTURE = 'packages/infra/queue/tests/fixtures/span-over-job-dispatch.fixture.ts';

type FixtureResult = {
  iterations: number;
  processorCalls: number;
  armA_directCallTransactions: number;
  armB_dispatchTransactions: number;
  armB_names: string[];
  armB_ops: string[];
  armB_sources: string[];
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
  const line = stdout.split('\n').find((l) => l.startsWith('SC822_RESULT '));
  if (exitCode !== 0 || !line) {
    // A killed or crashed subprocess returns empty output, and empty output
    // reads downstream as "nothing was transmitted" — which is arm A's PASSING
    // answer. Refuse rather than let a non-result be consumed as a verdict.
    throw new Error(
      `fixture produced no verdict (exit ${exitCode}).\nstdout: ${stdout}\nstderr: ${stderr}`
    );
  }
  return JSON.parse(line.slice('SC822_RESULT '.length)) as FixtureResult;
}

describe('a Sentry span over BullMQ job dispatch', () => {
  // One subprocess, both arms, because they must share one initialized client:
  // arm B is what proves arm A's zero would have been visible.
  let result: FixtureResult;

  test('the fixture reports a verdict for both arms', async () => {
    result = await runFixture();
    expect(result.iterations).toBeGreaterThan(0);
    // Both arms ran the same processor the same number of times, so a
    // difference between them cannot be a difference in how much work happened.
    expect(result.processorCalls).toBe(result.iterations * 2);
  });

  test('calling the processor directly transmits NO transaction', () => {
    // The population, so the zero is a measurement rather than an abstention:
    // the same client, in the same process, transmitted arm B's transactions.
    expect(result.armB_dispatchTransactions).toBeGreaterThan(0);
    expect(result.armA_directCallTransactions).toBe(0);
  });

  test('dispatch transmits a transaction per job, named and op-tagged', () => {
    expect(result.armB_dispatchTransactions).toBeGreaterThan(0);
    // The job NAME, never the job id: this is what Sentry aggregates on, so a
    // per-execution name would put every run in its own bucket.
    expect(result.armB_names).toEqual(['sc822-probe']);
    expect(result.armB_ops).toEqual(['queue.process']);
    expect(result.armB_sources).toEqual(['task']);
  });
});
