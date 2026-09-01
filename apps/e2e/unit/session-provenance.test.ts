import { describe, expect, test } from 'bun:test';
import { provenanceFailure, type SessionContent } from '../visual/session-provenance';

/**
 * That the SC-842 guard can actually fire.
 *
 * Same charter as `capture-size.test.ts`, and it belongs in `unit/` for the
 * same reason: this directory is the one place the root `test` script can point
 * at without sweeping `apps/e2e/tests/`'s Playwright specs into `bun test`.
 *
 * The defect this guard is FOR is a check reporting success over a picture
 * nobody has read, so a test asserting only the passing path would reproduce
 * that defect inside the guard's own coverage: a predicate that returns `null`
 * on every input passes a happy-path test perfectly. Every arm below therefore
 * has a stated counterpart it must NOT agree with.
 */

/** The seeded session as `visual-setup.ts` declares it. */
const SEEDED: SessionContent = { accounts: ['Everyday', 'Reserve', 'Brokerage'], holdings: 3 };

describe('provenanceFailure', () => {
  test('the declared seed passes — the control every arm below needs', () => {
    expect(
      provenanceFailure({
        session: 'seeded',
        expected: SEEDED,
        observed: { accounts: ['Reserve', 'Everyday', 'Brokerage'], holdings: 3 },
      })
    ).toBeNull();
  });

  test('an account nobody declared REFUSES — the arm the defect needs', () => {
    const message = provenanceFailure({
      session: 'seeded',
      expected: SEEDED,
      observed: {
        accounts: ['Everyday', 'Reserve', 'Brokerage', 'Joint Current'],
        holdings: 4,
      },
    });
    expect(message).not.toBeNull();
    // The session, the undeclared name and the way out, because a refusal
    // naming none of them is one the next person clears by deleting the check.
    expect(message).toContain('"seeded"');
    expect(message).toContain('Joint Current');
    expect(message).toContain('NOT DECLARED');
    expect(message).toContain('VISUAL_FRESH=1');
    expect(message).toContain('SC-842');
  });

  test('a seed that only half ran REFUSES, and says which account is missing', () => {
    const message = provenanceFailure({
      session: 'seeded',
      expected: SEEDED,
      observed: { accounts: ['Everyday', 'Reserve'], holdings: 2 },
    });
    expect(message).not.toBeNull();
    expect(message).toContain('MISSING');
    expect(message).toContain('Brokerage');
  });

  /**
   * The count is a SECOND axis, not decoration. A holding added to an account
   * the seed already names — an import test pointed at the fixture user, a
   * second run of the seeder — changes what every screen renders while leaving
   * the account set exactly right, so a check on names alone would agree with
   * it.
   */
  test('an extra holding under a declared account REFUSES, though every name matches', () => {
    const message = provenanceFailure({
      session: 'seeded',
      expected: SEEDED,
      observed: { accounts: ['Everyday', 'Reserve', 'Brokerage', 'Brokerage'], holdings: 4 },
    });
    expect(message).not.toBeNull();
    expect(message).toContain('4 holding(s)');
    expect(message).toContain('3 holding(s)');
  });

  /**
   * The empty session is the one whose declaration is an absence, and it is the
   * one where an unasserted absence is indistinguishable from a guard that
   * cannot fire. `home-empty-phone` is a picture of the onboarding panel, which
   * home renders only while the holdings count is zero — so a single holding
   * arriving in that user silently turns that baseline into a picture of a
   * different screen.
   */
  test('the empty session holding anything at all REFUSES', () => {
    expect(
      provenanceFailure({
        session: 'empty',
        expected: { accounts: [], holdings: 0 },
        observed: { accounts: ['Everyday'], holdings: 1 },
      })
    ).not.toBeNull();
  });

  test('control — an empty session that is genuinely empty passes', () => {
    expect(
      provenanceFailure({
        session: 'empty',
        expected: { accounts: [], holdings: 0 },
        observed: { accounts: [], holdings: 0 },
      })
    ).toBeNull();
  });
});

/**
 * The declaration is DERIVED from the seed in `visual-setup.ts` rather than
 * written out again, and this is the assertion that it still is.
 *
 * Read as text, because `apps/e2e/unit` cannot import that module — it pulls in
 * `@playwright/test`, which wants a runner around it. The same technique, for
 * the same reason, as `apps/frontend/app/tests/v3/visual-baselines.test.ts`
 * reading `screens.ts`.
 *
 * A hand-written expectation would be a second declaration of the fixture, and
 * the day the two disagree the guard asserts a portfolio nobody seeds — which
 * is a check that fires on every correct run, i.e. a check somebody deletes.
 */
describe('the declaration is derived from the seed, not restated', () => {
  const SETUP = new URL('../fixtures/visual-setup.ts', import.meta.url).pathname;

  test('DECLARED_CONTENT reads the two seed arrays', async () => {
    const source = await Bun.file(SETUP).text();
    const block = source.slice(source.indexOf('const DECLARED_CONTENT'));
    const declaration = block.slice(0, block.indexOf('\n};'));
    expect(declaration).toContain('PORTFOLIO.map');
    expect(declaration).toContain('ALLOCATION_PORTFOLIO.map');
  });

  test('control — those two arrays are what the seeders walk', async () => {
    const source = await Bun.file(SETUP).text();
    expect(source).toContain('for (const spec of PORTFOLIO)');
    expect(source).toContain('for (const spec of ALLOCATION_PORTFOLIO)');
  });
});
