import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import i18n from 'i18next';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import { CaptureList } from '../../../src/v3/components/capture/CaptureSheet';
import { CAPTURE_GROUPS, CAPTURE_ROUTES } from '../../../src/v3/lib/capture';

/**
 * `CaptureSheet` itself renders nothing under `renderToStaticMarkup` — both of
 * its shells are Radix portals, and Radix's `Portal` returns null until it has
 * mounted. So the list it wraps is exported and tested here, which is the half
 * that carries the ticket anyway: the frame is `PeekSheet`'s, already covered;
 * the content is what this ticket decided.
 *
 * `StaticRouter` rather than `MemoryRouter`, as everywhere else in these tests:
 * `Link` needs a router context to resolve an `href`, and the memory router
 * runs a `useLayoutEffect` that React warns about on every row under the
 * server renderer.
 */
function render(contextQuery = ''): string {
  return renderToStaticMarkup(
    <StaticRouter location="/">
      <CaptureList contextQuery={contextQuery} />
    </StaticRouter>
  );
}

// Resolved through the real instance against the shipped `en.json`, so a
// missing key fails the assertion instead of rendering as itself.
const t = i18n.t.bind(i18n);

describe('the capture list', () => {
  test('offers every route, once', () => {
    const markup = render();
    for (const route of CAPTURE_ROUTES) {
      expect(markup.split(t(route.titleKey)).length - 1).toBe(1);
    }
  });

  test('heads each group with what the person has, not with a subsystem', () => {
    const markup = render();
    for (const group of CAPTURE_GROUPS) expect(markup).toContain(t(group.titleKey));
    expect(markup).not.toContain('Portfolio');
  });

  test('no row warns about an older screen, because there is no older screen', () => {
    // V3-14 printed "Opens the classic screen" under the four rows that still
    // led to v2. V3-44 ported all four, so the caveat goes with them — and it
    // reappearing would mean a capture route had quietly gone back to v2.
    expect(render()).not.toContain('Opens the classic screen');
  });

  test('forwards context only to the routes that read it', () => {
    const markup = render('?accountId=acc-1');
    // Manual entry prefills from it; the exchange list has nowhere to put it.
    expect(markup).toContain('/manual-entry?accountId=acc-1');
    expect(markup).not.toContain('/integrations?accountId=acc-1');
  });

  test('every row is a link, so it can be opened in a new tab and read by a screen reader as one', () => {
    const markup = render();
    expect(markup.split('<a ').length - 1).toBe(CAPTURE_ROUTES.length);
  });
});
