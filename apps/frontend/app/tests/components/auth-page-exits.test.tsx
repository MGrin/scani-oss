import '../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import i18n from 'i18next';
import { renderToStaticMarkup } from 'react-dom/server';
import { AuthPageExits } from '../../src/components/AuthPageExits';

/**
 * The app's sign-in screen has a way out, and a top-level heading (SC-1209).
 *
 * It is SC-997's defect on the surface SC-997 did not cover, so this mirrors
 * `apps/frontend/cloud/tests/components/auth-page-exits.test.tsx` rather than
 * inventing a second shape. Measured before the fix, on `app.scani.xyz` and
 * again on a local stack — the second is the reading this test replaces:
 *
 *     anchors 0 · hrefs [] · headings H3:Welcome
 *
 * The control that makes that zero a reading rather than a selector which had
 * stopped matching: `cloud.scani.xyz/auth` returned 2 on the same day.
 */

const AUTH_PAGE = join(import.meta.dir, '../../src/pages/Auth.tsx');

function source(): string {
  return readFileSync(AUTH_PAGE, 'utf8');
}

describe('the app sign-in screen links out', () => {
  test('it offers the three exits a visitor without an account would want', () => {
    const html = renderToStaticMarkup(<AuthPageExits />);
    expect(html).toContain('href="https://scani.xyz"');
    expect(html).toContain('href="https://docs.scani.xyz"');
    expect(html).toContain('href="https://demo.scani.xyz"');
    // The count, not just the presence: this page's defect was an absence, and
    // a fourth exit added without a reason is the drift in the other direction.
    expect(html.match(/<a /g)?.length).toBe(3);
  });

  test('the exits are addresses, so nine locales have nothing to disagree about', () => {
    const html = renderToStaticMarkup(<AuthPageExits />);
    // Every anchor's text is its own hostname — the treatment cloud already
    // ships for `scani.xyz`. The one translated string is the nav's
    // accessible name, asserted below.
    for (const host of ['scani.xyz', 'docs.scani.xyz', 'demo.scani.xyz']) {
      expect(html).toContain(`>${host}<`);
    }
  });

  test('the nav carries an accessible name, resolved not guessed', () => {
    const html = renderToStaticMarkup(<AuthPageExits />);
    expect(html).toContain(`aria-label="${i18n.t('auth.exits.label')}"`);
    // Control: the key resolves. i18next renders a missing key AS the key, so
    // without this the assertion above would pass over `auth.exits.label`.
    expect(i18n.t('auth.exits.label')).toBe('More about Scani');
  });
});

describe('the app sign-in screen names itself', () => {
  /**
   * Three stages render this screen — the email form, "check your email", and
   * the code entry — and each already carried the wordmark as a `<span>`. It
   * is now the `h1`, which is what cloud's `AuthPage` has always had. Same
   * text, same classes, same position: `span` and `h1` are both blockified as
   * flex items, and Tailwind's preflight zeroes a heading's margin and
   * inherits its size, so nothing moves.
   */
  test('every stage renders the wordmark as an h1, and none as a span', () => {
    const text = source();
    const H1 = '<h1 className="text-3xl font-semibold tracking-tight">Scani</h1>';
    expect(text.split(H1).length - 1).toBe(3);
    // The state this replaces: an `h3` was the whole heading tree.
    const SPAN = '<span className="text-3xl font-semibold tracking-tight">Scani</span>';
    expect(text).not.toContain(SPAN);
  });

  /**
   * `CardTitle` is a shadcn primitive that hardcodes `<h3>`, so once the
   * wordmark became the `h1` the tree jumped a level — `H1:Scani` straight to
   * `H3:Welcome`. The stage title is a plain `h2` carrying exactly the classes
   * `cn` used to produce from CardTitle's base plus this page's own, measured
   * in a browser as 24px / 600 / centred / 0 margin either side, which is what
   * it rendered as before. The primitive itself is untouched: it is used all
   * over the app and its level is not this row's business.
   */
  test('the stage title is an h2, so the tree skips no level', () => {
    const text = source();
    const H2 = '<h2 className="text-2xl text-center font-semibold leading-none tracking-tight">';
    expect(text.split(H2).length - 1).toBe(3);
    // Control: the page no longer reaches the h3 primitive at all, so the
    // count above is the whole heading tree rather than three of four.
    expect(text).not.toContain('CardTitle');
  });

  test('every stage mounts the exits, so no step of the flow is a dead end', () => {
    // The same placement cloud uses, and the reason its code stage kept its
    // way out too.
    expect(source().split('<AuthPageExits />').length - 1).toBe(3);
  });

  test('the exits sit after the card they follow, not inside the form', () => {
    const text = source();
    const mounts = [...text.matchAll(/<AuthPageExits \/>/g)].map((m) => m.index ?? -1);
    const closes = [...text.matchAll(/<\/Card>/g)].map((m) => m.index ?? -1);
    expect(mounts).toHaveLength(3);
    // Control: three cards to be after. Without this the loop below would
    // pass vacuously if the page stopped using `Card` at all.
    expect(closes).toHaveLength(3);
    for (const [index, mount] of mounts.entries()) {
      expect(mount, `stage ${index + 1} mounts the exits before its card closes`).toBeGreaterThan(
        closes[index] as number
      );
    }
  });
});
