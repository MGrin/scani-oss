import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import i18n from 'i18next';
import { renderToStaticMarkup } from 'react-dom/server';
import { NAV_BADGE_CAP, V3NavBadge } from '../../../src/v3/layouts/V3NavBadge';

/**
 * The nav badge is bounded, and bounding it did not cost the number (SC-905).
 *
 * SC-860 made `reviewBadgeCount` sum `represents` instead of counting rows, so
 * the value became unbounded where it used to top out near the number of
 * collectors. Measured on a running stack, what that costs is narrower than
 * the ticket claimed — the drawer tile first LEAVES its box at seven digits at
 * a 16px root font, and at five digits at a 280px viewport with the browser
 * font set to 24px, because every v3 token is `rem` while the drawer grid is a
 * fraction of the viewport. Four digits never clipped anywhere.
 *
 * So these tests pin the two properties that make the badge bounded rather
 * than a number this file has to keep re-checking against a screen:
 *
 * 1. Past the cap the VISIBLE string stops growing — one more digit in the
 *    count is zero more pixels.
 * 2. The ACCESSIBLE name still carries the exact count. A `Math.min` would
 *    pass (1) and fail (2), and failing (2) is trading a layout bound for a
 *    lost fact — which is the failure worth a test, because nothing on screen
 *    would show it.
 */

const strip = (html: string) => html.replace(/<[^>]+>/g, '');

/** What a screen reader is handed: everything not `aria-hidden`. */
const announced = (html: string) =>
  strip(html.replace(/<span aria-hidden="true">.*?<\/span>/g, ''));

/** What a sighted reader is handed: everything not `sr-only`. */
const visible = (html: string) => strip(html.replace(/<span class="sr-only">.*?<\/span>/g, ''));

describe('the nav badge', () => {
  test('renders nothing at zero', () => {
    expect(renderToStaticMarkup(<V3NavBadge count={0} />)).toBe('');
  });

  test('spells the count out up to the cap', () => {
    for (const count of [1, 9, NAV_BADGE_CAP - 1, NAV_BADGE_CAP]) {
      const html = renderToStaticMarkup(<V3NavBadge count={count} />);
      expect(visible(html)).toBe(String(count));
      expect(html).not.toContain('sr-only');
    }
  });

  test('the visible string stops growing past the cap', () => {
    const overflow = `${NAV_BADGE_CAP}+`;
    for (const count of [NAV_BADGE_CAP + 1, 999, 1234, 99_999, 9_999_999]) {
      expect(visible(renderToStaticMarkup(<V3NavBadge count={count} />))).toBe(overflow);
    }
  });

  test('the exact count survives the cap, for anyone not reading pixels', () => {
    for (const count of [NAV_BADGE_CAP + 1, 1234, 9_999_999]) {
      expect(announced(renderToStaticMarkup(<V3NavBadge count={count} />))).toBe(String(count));
    }
  });

  /**
   * `+` is not universal, so it is a string a translator can reach — and the
   * interpolation is `cap` rather than `count` on purpose: `count` puts
   * i18next into plural resolution, and a key with no `_one`/`_other` beside
   * it then resolves to nothing and renders empty.
   */
  test('the overflow string is translated, not concatenated', () => {
    expect(renderToStaticMarkup(<V3NavBadge count={5000} />)).toContain(`${NAV_BADGE_CAP}+`);
    expect(i18n.t('v3.shell.navBadge.overflow', { cap: NAV_BADGE_CAP })).toBe(`${NAV_BADGE_CAP}+`);
    // The trap, asserted rather than remembered: a `count` interpolation would
    // send i18next looking for `overflow_other`, find nothing, and render the
    // key back.
    expect(i18n.t('v3.shell.navBadge.overflow', { count: NAV_BADGE_CAP })).not.toBe(
      `${NAV_BADGE_CAP}+`
    );
  });
});

/**
 * Both surfaces, which is the half a component test cannot see.
 *
 * The sidebar and the drawer had the same pill written out twice with
 * different positioning, and capping one of them is a fix that looks complete
 * from either file. They have different budgets too — measured, the sidebar
 * has ~140px of slack where the drawer tile has ~63px — so the drawer is the
 * one that governs and the sidebar is the one where a regression would be
 * invisible for longest.
 */
describe('both nav surfaces go through it', () => {
  const LAYOUTS = ['V3Sidebar.tsx', 'V3MoreDrawer.tsx'];

  for (const file of LAYOUTS) {
    test(`${file} renders the badge through the shared component`, () => {
      const src = readFileSync(resolve(import.meta.dir, '../../../src/v3/layouts', file), 'utf8');
      expect(src).toContain('<V3NavBadge');
      // The pill it replaced, so a re-inlined copy fails here rather than
      // shipping an uncapped second spelling.
      expect(src).not.toContain('rounded-full bg-interactive');
    });
  }
});
