import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isPrimaryCheckout,
  resolveStackPorts,
  STACK_SERVICES,
  stackPortOverrides,
  stackPorts,
} from '../lib/worktree';

/**
 * SC-500. `portOffset` hands a linked worktree one of 20 slots, and its own
 * comment said two worktrees drawing the same one "collides loudly on a port
 * bind, and the override below is the answer". There was no override: every
 * consumer derived its port and used it, so a `<SERVICE>_HOST_PORT` already in
 * the environment was discarded without a word.
 *
 * WHY THIS FILE EXISTS SEPARATELY from `scripts/tests/dev-stack.test.ts`,
 * which covers the same feature's private half: nothing in CI ever SETS a
 * `<SERVICE>_HOST_PORT`. So every automated run upstream — including the E2E
 * job that drives `apps/e2e/scripts/run.ts` — exercises the DERIVATION path,
 * which already worked, and never the OVERRIDE path, which is the whole
 * change. A green badge for the behaviour that was not modified is worse than
 * no badge, because it reads as coverage.
 *
 * It imports `scripts/lib/worktree.ts` and nothing else on purpose. Every
 * other consumer of these ports is private-only, and a test that reached for
 * one would not run in the mirror.
 */
describe('an override in the environment wins over the derived port', () => {
  /**
   * Synthetic on purpose (SC-566). Everything under test here hashes the path
   * string and never touches disk, so a fixture naming a real checkout bought
   * nothing and cost twice: it published one machine's directory layout to the
   * public mirror, and it named a bb worktree that was later reaped, which is
   * the shape SC-563 spent a red `main` diagnosing.
   *
   * One constraint on whatever path replaces this one: its derived
   * POSTGRES_HOST_PORT must not equal the override literal below, or the
   * assertion that the override CHANGED something is comparing a value to
   * itself. One of the twenty offset slots lands on it, and the test goes red
   * rather than quiet when it does.
   */
  const WORKTREE = '/fixture/worktrees/env_fixture01/scani';
  const PRIMARY = '/fixture/checkouts/primary/scani';

  test('a set <SERVICE>_HOST_PORT replaces the derived one', () => {
    const derived = stackPorts(WORKTREE, false).POSTGRES_HOST_PORT;
    const resolved = resolveStackPorts(WORKTREE, false, { POSTGRES_HOST_PORT: '7233' });
    expect(resolved.POSTGRES_HOST_PORT).toBe(7233);
    expect(resolved.POSTGRES_HOST_PORT).not.toBe(derived);
  });

  test('the services nobody overrode keep the derivation', () => {
    const resolved = resolveStackPorts(WORKTREE, false, { POSTGRES_HOST_PORT: '7233' });
    expect(resolved.FRONTEND_HOST_PORT).toBe(stackPorts(WORKTREE, false).FRONTEND_HOST_PORT);
  });

  test('nothing set is exactly the derivation, for the primary and for a worktree', () => {
    // The path every CI run takes. It has to stay byte-for-byte what it was.
    expect(resolveStackPorts(WORKTREE, false, {})).toEqual(stackPorts(WORKTREE, false));
    expect(resolveStackPorts(PRIMARY, true, {})).toEqual(stackPorts(PRIMARY, true));
  });

  test('every service the stack publishes can be overridden, not just Postgres', () => {
    // An override honouring some services and not others would be worse than
    // none: half the stack moved and half still colliding.
    for (const service of STACK_SERVICES) {
      expect(resolveStackPorts(WORKTREE, false, { [service.env]: '4321' })[service.env]).toBe(4321);
    }
  });

  test('an unrelated variable cannot move a service', () => {
    // Only the names `STACK_SERVICES` carries are read, so a `PORT` or a
    // `POSTGRES_PORT` in somebody's shell is not an override.
    expect(stackPortOverrides({ PORT: '1234', POSTGRES_PORT: '1234' })).toEqual({});
  });

  test('an empty or whitespace value is not an override', () => {
    // `POSTGRES_HOST_PORT=` in a .env means unset, not port zero.
    expect(stackPortOverrides({ POSTGRES_HOST_PORT: '' })).toEqual({});
    expect(stackPortOverrides({ POSTGRES_HOST_PORT: '  ' })).toEqual({});
  });

  /**
   * THE PERSUASIVE CASE, and the one a future reader will want to soften.
   *
   * Falling back to the derived port when the value does not parse is the
   * reasonable-looking thing, and it is the exact defect this function exists
   * to close: an override that is ignored points the stack, the gate and the
   * e2e run at a server the operator believes they moved away from, and says
   * nothing. A refusal naming the variable is recoverable in one step; a
   * silent fallback is unrecoverable because nobody knows to look.
   */
  test('a malformed override THROWS rather than falling back to the derivation', () => {
    for (const bad of ['abc', '0', '-1', '65536', '5433.5']) {
      expect(() => stackPortOverrides({ POSTGRES_HOST_PORT: bad })).toThrow('POSTGRES_HOST_PORT');
    }
  });
});

/**
 * SC-563. `isPrimaryCheckout` decides the port offset for every stack, gate
 * and e2e run, and it answered `true` — "this IS the primary checkout", which
 * means offset 0, which means the documented ports — for THREE different
 * failures that one condition could not tell apart:
 *
 *   real directory, not a repository   git exits 128
 *   git not installed                  spawn fails, ENOENT, no exit status
 *   the directory does not exist       spawn fails, ENOENT, no exit status
 *
 * The first two are a decision, argued in that function's own comments: there
 * is nothing to be a second copy of, so the documented ports are right, and a
 * contributor who unpacks a source tarball meets this on their first command.
 * The third is not. A path that does not exist describes nothing, and both
 * answers are wrong for it.
 *
 * What it cost: `scripts/tests/dev-stack.test.ts` named a bb worktree that had
 * since been reaped, so `bun run test` was red on `main` for everyone with
 * `Expected "5673" Received "5173"` — a message about a PORT, which reads as a
 * derivation regression and sent people into this file looking for one.
 */
describe('isPrimaryCheckout separates "not a repository" from "not a directory"', () => {
  test('a path that does not exist throws, and names itself', () => {
    const parent = mkdtempSync(join(tmpdir(), 'scani-primary-check-'));
    const absent = join(parent, 'no-such-checkout');
    try {
      // Non-vacuous: if this ever existed the assertion below would be
      // asserting the wrong thing entirely.
      expect(existsSync(absent)).toBe(false);
      expect(() => isPrimaryCheckout(absent)).toThrow(absent);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  /**
   * THE TEST A FUTURE READER WILL WANT TO DELETE, and the reason is a good
   * one: "a probe that could not run should not answer" is a clean principle,
   * and this test is the only thing standing between it and the codebase.
   *
   * Argue with the reason, not the assertion. Generalising the throw to every
   * failed probe would refuse a directory that is simply not a git repository
   * — an unpacked source tarball, a self-host copy, a machine without git —
   * which is exactly the case the function's docblock defends and the first
   * thing a new contributor does. That would be a worse bug than the one being
   * fixed, shipped as a principle.
   */
  test('a real directory that is not a repository is primary, not an error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scani-not-a-repo-'));
    try {
      expect(isPrimaryCheckout(dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a real checkout is answered rather than refused', () => {
    // The other direction: a guard that fired on everything would pass both
    // tests above and break every caller. This repo is either the primary
    // checkout or a linked worktree, and both are legitimate answers.
    const here = join(import.meta.dir, '..', '..');
    expect(typeof isPrimaryCheckout(here)).toBe('boolean');
  });
});
