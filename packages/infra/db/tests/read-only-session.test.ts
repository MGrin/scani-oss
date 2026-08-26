import { describe, expect, test } from 'bun:test';

/**
 * What SC-422 actually promises: an operator script's dry run cannot write, and
 * Postgres is the thing refusing — not the script's own care.
 *
 * These run the REAL entry path in a subprocess rather than assembling a
 * client here, because the claim is about `@scani/db/connection`, and a test
 * that builds its own options tests its own options. The fixture lives in a
 * directory named `scripts/` because since SC-646 the DIRECTORY is the input.
 *
 * All three invocations are asserted, and the two writing ones are not
 * decoration. A dry run that refuses a write proves nothing on its own — a
 * connection hard-wired read-only would pass it, and would also break every
 * repair anyone ever committed. `--apply` has its own case because ten scripts
 * spell their write flag that way; SC-646 made the connection understand it,
 * and a change that quietly stopped would leave those ten unable to write with
 * no test to notice.
 */

const FIXTURE = new URL('./fixtures/scripts/read-only-probe.ts', import.meta.url).pathname;

interface Probe {
  isReadOnlySession: boolean;
  sessionSaysReadOnly?: boolean;
  readWorks?: boolean;
  wrote?: boolean;
  writeErrorCode?: string;
  showFailed?: string;
  readFailed?: string;
}

async function probe(...args: string[]): Promise<Probe> {
  const proc = Bun.spawn(['bun', FIXTURE, ...args], {
    env: { ...process.env, NODE_ENV: 'test' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  const line = stdout.split('\n').find((l) => l.startsWith('SC422_PROBE '));
  if (!line) throw new Error(`probe produced no result.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  return JSON.parse(line.slice('SC422_PROBE '.length)) as Probe;
}

describe('an operator script dry run', () => {
  test('opens a session Postgres itself refuses writes on, while reads still work', async () => {
    const result = await probe();

    expect(result.isReadOnlySession).toBe(true);
    expect(result.sessionSaysReadOnly).toBe(true);
    expect(result.readWorks).toBe(true);
    expect(result.wrote).toBe(false);
    // 25006 = read_only_sql_transaction. The specific code matters: a write
    // that failed for any other reason would satisfy `wrote === false` while
    // proving nothing about the connection.
    expect(result.writeErrorCode).toBe('25006');
  }, 30000);
});

describe('the same script with --commit', () => {
  // The negative control. Without it, deleting the flag entirely and hard-
  // wiring read-only would pass the test above.
  test('opens a writable session', async () => {
    const result = await probe('--commit');

    expect(result.isReadOnlySession).toBe(false);
    expect(result.sessionSaysReadOnly).toBe(false);
    expect(result.readWorks).toBe(true);
    expect(result.wrote).toBe(true);
    expect(result.writeErrorCode).toBeUndefined();
  }, 30000);
});

describe('the same script with --apply', () => {
  // The other write spelling, and the one the ten SC-646 scripts use. Asserted
  // against the live session rather than against the policy function, because
  // the failure this guards is a script that believes it is committing while
  // the connection refuses every write it makes.
  test('opens a writable session too', async () => {
    const result = await probe('--apply');

    expect(result.isReadOnlySession).toBe(false);
    expect(result.sessionSaysReadOnly).toBe(false);
    expect(result.readWorks).toBe(true);
    expect(result.wrote).toBe(true);
    expect(result.writeErrorCode).toBeUndefined();
  }, 30000);
});
