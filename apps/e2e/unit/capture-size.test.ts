import { describe, expect, test } from 'bun:test';
import {
  BASELINE_SHRINK_ALLOW_ENV,
  baselineBytes,
  baselineCollapse,
  MIN_BASELINE_RATIO,
} from '../visual/capture-size';

/**
 * That the SC-867 guard can actually fire.
 *
 * Same charter as `stability.test.ts`, and it belongs in `unit/` for the same
 * reason that file gives: this directory is the one place the root `test`
 * script can point at without sweeping `apps/e2e/tests/`'s Playwright specs
 * into `bun test`.
 *
 * The defect this guard is FOR is a check that reports success over a picture
 * nobody has seen, so a test asserting only the passing path would reproduce
 * that defect inside the guard's own coverage: a predicate that returns `null`
 * on every input passes a happy-path test perfectly. Every arm below therefore
 * has a stated counterpart it must NOT agree with.
 */

/**
 * The two pairs that set the floor, both measured — see `MIN_BASELINE_RATIO`.
 *
 * `SHALLOWEST_ARTEFACT` is the loading-state capture that collapsed LEAST of
 * the eight data-driven screens, and `TIGHTEST_REAL_UPDATE` is the smallest
 * ratio any committed baseline update has ever produced in this repository.
 * Asserting the floor against the two closest real observations rather than
 * against round numbers is what makes this test a discriminator: a floor that
 * drifted into either distribution fails here rather than in a gate run
 * somebody is trying to land.
 */
const SHALLOWEST_ARTEFACT = { screen: 'holdings-desktop-rtl', before: 66_467, after: 35_184 };
const TIGHTEST_REAL_UPDATE = { screen: 'holdings-phone', before: 38_302, after: 35_876 };

describe('baselineCollapse', () => {
  test('a collapsed baseline REFUSES — the arm the defect needs', () => {
    const message = baselineCollapse({
      screen: 'kitchen-sink-desktop',
      before: 624_374,
      after: 32_728,
      allowed: undefined,
    });
    expect(message).not.toBeNull();
    // The screen, both numbers and the way out, because a refusal naming none
    // of them is one the next person clears by deleting the check.
    expect(message).toContain('kitchen-sink-desktop');
    expect(message).toContain('624,374');
    expect(message).toContain('32,728');
    expect(message).toContain(BASELINE_SHRINK_ALLOW_ENV);
    expect(message).toContain('SC-867');
  });

  test('a baseline that did not move passes — the control the arm above needs', () => {
    expect(
      baselineCollapse({
        screen: 'kitchen-sink-desktop',
        before: 624_374,
        after: 624_374,
        allowed: undefined,
      })
    ).toBeNull();
  });

  test('the floor sits between the two closest real observations', () => {
    // The whole calibration in one pair. Neither assertion is interesting
    // alone — a floor of 0 passes the first and a floor of 1 passes the
    // second — and together they pin it inside the 40.8-point gap the two
    // measured distributions leave.
    expect(baselineCollapse({ ...SHALLOWEST_ARTEFACT, allowed: undefined })).not.toBeNull();
    expect(baselineCollapse({ ...TIGHTEST_REAL_UPDATE, allowed: undefined })).toBeNull();
  });

  test('a screen with no baseline yet is not refused', () => {
    // A first capture destroys no evidence and has nothing to be compared
    // against. This is the deliberate hole SC-867 calls "the harmless
    // direction", and it is asserted so that closing it is a decision rather
    // than a surprise.
    expect(
      baselineCollapse({ screen: 'brand-new', before: null, after: 4_000, allowed: undefined })
    ).toBeNull();
  });

  test('the override clears the screen it NAMES and no other', () => {
    const shrink = {
      before: 624_374,
      after: 32_728,
      allowed: 'holdings-phone,kitchen-sink-desktop',
    };
    expect(baselineCollapse({ screen: 'kitchen-sink-desktop', ...shrink })).toBeNull();
    // The half that matters. A blanket flag would clear all twelve on the
    // strength of somebody having looked at one, which is why the variable
    // takes names and not `1`.
    expect(baselineCollapse({ screen: 'home-desktop', ...shrink })).not.toBeNull();
    expect(
      baselineCollapse({ screen: 'kitchen-sink-desktop', ...shrink, allowed: '1' })
    ).not.toBeNull();
  });

  test('the floor is where the constant says, on both sides of it', () => {
    const before = 100_000;
    const floor = before * MIN_BASELINE_RATIO;
    expect(baselineCollapse({ screen: 's', before, after: floor, allowed: undefined })).toBeNull();
    expect(
      baselineCollapse({ screen: 's', before, after: floor - 1, allowed: undefined })
    ).not.toBeNull();
  });
});

describe('baselineBytes', () => {
  test('reads a real file and returns null for an absent one', () => {
    // A positive control, because `null` is what this returns when it cannot
    // read anything — and a reader that always returned `null` would switch
    // the guard off silently for every screen at once.
    expect(baselineBytes(new URL(import.meta.url).pathname)).toBeGreaterThan(0);
    expect(baselineBytes('/nonexistent/no-such-baseline.png')).toBeNull();
  });
});
