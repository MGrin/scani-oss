import { describe, expect, test } from 'bun:test';
import { resolveStackPorts, STACK_SERVICES, stackPortOverrides, stackPorts } from '../lib/worktree';

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
  const WORKTREE = '/Users/mgrin/.bb/worktrees/env_v6j457ukyh/scani';

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
    expect(resolveStackPorts('/Users/mgrin/Projects/mgrin/scani', true, {})).toEqual(
      stackPorts('/Users/mgrin/Projects/mgrin/scani', true)
    );
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
