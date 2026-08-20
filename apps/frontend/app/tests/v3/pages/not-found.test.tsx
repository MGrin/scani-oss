import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import i18n from 'i18next';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import { NotFoundPage } from '../../../src/v3/pages/NotFoundPage';

/**
 * The app's terminal 404 has a destination, and the catch-all points at it
 * (SC-423).
 *
 * v2 used to be that destination: v3's catch-all forwarded every path it did
 * not route to `/v2/<same path>`, and v2's own `NotFoundPage` was the screen
 * that answered. Deleting v2 without replacing it would have made an unrouted
 * path render `null` — `V3Shell` is a layout route, and a layout route whose
 * children all miss renders nothing at all. No header, no tab bar, no console
 * error, no error boundary, and in the installed PWA no address bar to leave
 * it by. That exact failure has shipped twice (SC-62, SC-73), which is why
 * this file gates it rather than a reviewer.
 *
 * Two halves, and both are needed. The screen is *rendered*, so a change that
 * empties it fails here; the route is read from `V3App.tsx` as source, because
 * `V3App` cannot be mounted without the whole authenticated shell under it and
 * a guard that expensive is a guard that gets skipped.
 */

const V3_APP = join(import.meta.dir, '../../../src/v3/V3App.tsx');

function render(pathname: string, search = ''): string {
  return renderToStaticMarkup(
    createElement(
      StaticRouter,
      { location: `${pathname}${search}` },
      createElement(NotFoundPage, {
        location: { pathname, search, hash: '', state: null, key: 'test' },
      })
    )
  );
}

describe('the v3 not-found screen', () => {
  test('says what happened and quotes the address that failed', () => {
    const html = render('/add-data', '?from=email');

    expect(html).toContain(i18n.t('v3.notFound.title'));
    expect(html).toContain(i18n.t('v3.notFound.body'));
    // The address, verbatim and including its query — the reader's own
    // evidence that the link was wrong rather than the app.
    expect(html).toContain('/add-data?from=email');
  });

  /**
   * The way back, and it has to be a real one. A 404 whose only exit is the
   * shell is survivable on a phone with the drawer open and nowhere else.
   */
  test('offers a link to the home screen', () => {
    expect(render('/nope')).toContain(`href="/"`);
    expect(render('/nope')).toContain(i18n.t('v3.notFound.goHome'));
  });

  /**
   * Russian, because this is the screen a reader reaches by accident and the
   * one place an untranslated string is least likely to be noticed by anyone
   * who could fix it. `getFixedT` rather than `changeLanguage` so the rest of
   * the suite keeps rendering in English.
   */
  test('is translated', () => {
    const ru = i18n.getFixedT('ru');
    for (const key of ['v3.notFound.title', 'v3.notFound.body', 'v3.notFound.goHome']) {
      expect(ru(key)).not.toBe(i18n.t(key));
      expect(ru(key)).toMatch(/[а-яА-ЯёЁ]/);
    }
  });
});

describe("v3's catch-all", () => {
  const source = readFileSync(V3_APP, 'utf8');

  test('resolves to the not-found screen', () => {
    const catchAlls = source.match(/<Route path="\*"[^>]*>/g) ?? [];

    // Exactly one, or the second one is unreachable and this guard is
    // asserting the wrong route.
    expect(catchAlls).toHaveLength(1);
    expect(catchAlls[0]).toContain('<NotFoundPage');
    expect(source).toContain("import { NotFoundPage } from './pages/NotFoundPage';");
  });

  /**
   * Nested inside the shell, not beside it. Registered as a sibling of
   * `<Route element={<V3Shell />}>` the screen would render with no tab bar,
   * no drawer and no sidebar — which is most of the reason it exists.
   */
  test('renders inside the shell', () => {
    const lines = source.split('\n');
    const shellOpens = lines.findIndex((l) => l.includes('<Route element={<V3Shell />}>'));
    const shellCloses = lines.findIndex((l, i) => i > shellOpens && l.trim() === '</Route>');
    const catchAll = lines.findIndex((l) => l.includes('<Route path="*"'));

    expect(shellOpens).toBeGreaterThanOrEqual(0);
    expect(catchAll).toBeGreaterThan(shellOpens);
    expect(catchAll).toBeLessThan(shellCloses);
  });

  /**
   * The scan is only worth having if it can fail. A renamed component or a
   * reformatted route would otherwise make every assertion above pass over an
   * empty match set.
   */
  test('the scan is reading real routes', () => {
    expect(source.match(/<Route path=/g)?.length ?? 0).toBeGreaterThan(20);
    expect(
      (`<Route path="*" element={<Nothing />} />`.match(/<Route path="\*"[^>]*>/g) ?? [])[0]
    ).not.toContain('<NotFoundPage');
  });
});
