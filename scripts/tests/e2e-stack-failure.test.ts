import { describe, expect, test } from 'bun:test';
import {
  type ComposeContainerState,
  type DiskReading,
  describeStackState,
  parseComposePs,
  stackServiceIsBroken,
} from '../../apps/e2e/scripts/run.ts';

/**
 * SC-894. The private `Accessibility gate & mobile smoke` job failed at
 * 2026-09-01T02:39:02Z after 4m18s, and the entire diagnosis it produced was:
 *
 *   Stack failed to start.
 *   error: script "test:e2e:a11y" exited with code 1
 *
 * Nobody reading that can tell a timed-out wait from a crashed container from
 * a compose file that would not parse. The cause was the runner's DISK, which
 * is the case that makes the message matter most: a full disk is the one boot
 * failure a service cannot report, because writing the log line needs the same
 * disk that ran out. `deps` printed `bun install v1.3.13` and then nothing,
 * and the only evidence anywhere in the job was an `ENOSPC` from
 * `actions/checkout`'s post-step three seconds later.
 *
 * So the message is the artefact under test, not a side effect of one. Same
 * seam as `resolveApiService` (SC-725): `apps/e2e/scripts/run.ts` boots a
 * compose stack and calls `process.exit`, so the only part of it any test can
 * reach is the part that was made pure. This file lives in `scripts/tests/`
 * because that is the one directory both the private local gate and upstream
 * CI execute — `apps/e2e/` is in neither.
 *
 * WHAT IT DOES NOT DO: boot a stack, or run docker. A check that needs Docker
 * fails on a machine without it, which is CLAUDE.md's stated reason for
 * keeping the visual gate out of the main gate.
 */

const GIB = 1024 ** 3;

function container(over: Partial<ComposeContainerState>): ComposeContainerState {
  return { service: 'x', state: 'running', exitCode: 0, health: '', ...over };
}

const ROOMY: DiskReading[] = [
  { label: 'checkout', path: '/work/scani', free: 40 * GIB, total: 72 * GIB },
];
const FULL: DiskReading[] = [
  { label: 'checkout', path: '/work/scani', free: 0.4 * GIB, total: 72 * GIB },
];

describe('parseComposePs accepts both shapes docker emits', () => {
  /**
   * Which shape you get is a property of the READER's compose version, not of
   * this repo — so a parser that handles one of them does not fail loudly. It
   * returns an empty list, and `describeStackState` then prints a confident
   * "compose reported no containers", which is a settled-sounding sentence
   * about the wrong thing. That is the defect this whole file exists about,
   * reproduced inside the fix.
   */
  const ROW = { Service: 'deps', State: 'exited', ExitCode: 1, Health: '' };

  test('a JSON array', () => {
    expect(parseComposePs(JSON.stringify([ROW]))).toEqual([
      { service: 'deps', state: 'exited', exitCode: 1, health: '' },
    ]);
  });

  test('one object per line', () => {
    const ndjson = `${JSON.stringify(ROW)}\n${JSON.stringify({ ...ROW, Service: 'migrate' })}`;
    expect(parseComposePs(ndjson).map((c) => c.service)).toEqual(['deps', 'migrate']);
  });

  test('empty output is no containers, not a crash', () => {
    expect(parseComposePs('')).toEqual([]);
    expect(parseComposePs('   \n  ')).toEqual([]);
  });

  test('a row with no Service is dropped rather than guessed at', () => {
    // The service name is the only field the report is built on, so a row
    // without one would render as an unnamed failure — worse than absent.
    expect(parseComposePs(JSON.stringify([{ State: 'exited', ExitCode: 1 }]))).toEqual([]);
  });

  test('unparseable output does not take the readable rows with it', () => {
    expect(parseComposePs(`not json\n${JSON.stringify(ROW)}`).map((c) => c.service)).toEqual([
      'deps',
    ]);
  });
});

describe('a one-shot that finished is not a failure', () => {
  // `env-sync`, `deps`, `migrate` and `minio-init` all end `exited 0` on a
  // healthy boot. Calling those broken would name four services every time
  // and make the report worth ignoring.
  test('exited 0 is fine, exited non-zero is not', () => {
    expect(stackServiceIsBroken(container({ state: 'exited', exitCode: 0 }))).toBe(false);
    expect(stackServiceIsBroken(container({ state: 'exited', exitCode: 1 }))).toBe(true);
  });

  test('running is fine unless its healthcheck says otherwise', () => {
    expect(stackServiceIsBroken(container({ state: 'running', health: 'healthy' }))).toBe(false);
    expect(stackServiceIsBroken(container({ state: 'running', health: '' }))).toBe(false);
    expect(stackServiceIsBroken(container({ state: 'running', health: 'unhealthy' }))).toBe(true);
  });

  test('anything that never reached a good state is broken', () => {
    for (const state of ['created', 'restarting', 'dead', 'paused', 'unknown']) {
      expect(stackServiceIsBroken(container({ state }))).toBe(true);
    }
  });
});

describe('the report names the service and the reason', () => {
  test('the failing service and its exit code, by name', () => {
    const report = describeStackState(
      [
        container({ service: 'postgres', health: 'healthy' }),
        container({ service: 'deps', state: 'exited', exitCode: 1 }),
      ],
      ROOMY
    );
    expect(report).toContain('Did not come up:');
    expect(report).toContain('deps');
    expect(report).toContain('exited 1');
    // The half that says what DID work — without it a reader cannot tell a
    // single crashed service from a stack that never started.
    expect(report).toContain('postgres');
  });

  test('a container that was created and never started says so', () => {
    // compose leaves `migrate` here when the thing it depends on failed, and
    // `created` on its own reads like a step that is still in progress.
    const report = describeStackState([container({ service: 'migrate', state: 'created' })], ROOMY);
    expect(report).toContain('never started');
  });

  test('no containers at all is reported as upstream of any service', () => {
    // A compose file that would not parse, an image that would not pull, a
    // docker that is not running. Naming a service here would be a guess.
    const report = describeStackState([], ROOMY);
    expect(report).toContain('upstream of');
    expect(report).not.toContain('Did not come up:');
  });

  test('every container healthy is stated, not silently omitted', () => {
    // `up` can fail for a reason none of the containers show. Printing
    // nothing would leave the reader assuming the report had not run.
    const report = describeStackState([container({ service: 'postgres' })], ROOMY);
    expect(report).toContain('the failure is not');
    expect(report).toContain('postgres');
  });
});

describe('disk is read before anything else, because it explains an empty log', () => {
  test('a roomy disk is reported as a figure and nothing more', () => {
    const report = describeStackState([container({ service: 'deps', state: 'exited' })], ROOMY);
    expect(report).toContain('40.0 GiB free');
    expect(report).not.toContain('OUT OF DISK');
  });

  test('a full disk is called out in words, not left as a figure to compare', () => {
    const report = describeStackState(
      [container({ service: 'deps', state: 'exited', exitCode: 1 })],
      FULL
    );
    expect(report).toContain('OUT OF DISK');
    expect(report).toContain('/work/scani');
    // The load-bearing sentence: it is why the container's own log is empty.
    expect(report).toContain('EMPTY log');
  });

  test('an unreadable filesystem is said to be unreadable, never reported as 0', () => {
    // On a Mac the docker root is inside a VM and is not a host path at all.
    // `0 GiB free` there would be a fabricated out-of-disk verdict — the
    // exact false-settled-answer this ticket is about, pointing the reader at
    // a cause that is not theirs.
    const report = describeStackState(
      [container({ service: 'deps', state: 'exited', exitCode: 1 })],
      [
        { label: 'checkout', path: '/work/scani', free: 40 * GIB, total: 72 * GIB },
        { label: 'docker root', path: '/var/lib/docker', free: null, total: null },
      ]
    );
    expect(report).toContain('not readable from this host');
    expect(report).not.toContain('OUT OF DISK');
  });
});
