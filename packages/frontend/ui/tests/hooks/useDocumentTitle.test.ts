import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  createDocumentTitleClaims,
  type DocumentTitleTarget,
  formatDocumentTitle,
} from '@scani/ui/hooks/useDocumentTitle';

/**
 * SC-996. Every route used to share one `<title>`, so an installed PWA's window,
 * browser history and bookmarks all read the app's name and nothing else.
 *
 * The hook is one `useEffect`; what is worth pinning is the ranking it feeds,
 * because that is what a peek relies on. A list page and the peek opened over
 * it are mounted at the same time and both claim the title — the record must
 * win while it is open, and the list must get the tab back when it closes.
 * Orders stand in for render order: a parent renders before its children.
 */

function harness(brand?: string) {
  const doc: DocumentTitleTarget = { title: 'Scani - Personal Finance Management' };
  return { doc, claims: createDocumentTitleClaims(() => doc, brand) };
}

describe('the document title', () => {
  test('is the page, then the brand', () => {
    expect(formatDocumentTitle('Holdings', 'Scani')).toBe('Holdings · Scani');
  });

  test('a peek over a list names the record, and closing it gives the list back', () => {
    const { doc, claims } = harness();
    claims.claim(1, 'Holdings');
    expect(doc.title).toBe('Holdings · Scani');

    claims.claim(2, 'GBP');
    expect(doc.title).toBe('GBP · Scani');

    claims.release(2);
    expect(doc.title).toBe('Holdings · Scani');
  });

  test('a deep link to a peek still names the record, whichever effect runs first', () => {
    // React runs a child's effect before its parent's, so on a cold deep link
    // the peek claims first. Ranking by claim time would hand the tab to the
    // list; ranking by render order does not.
    const { doc, claims } = harness();
    claims.claim(2, 'GBP');
    claims.claim(1, 'Holdings');
    expect(doc.title).toBe('GBP · Scani');
  });

  test('a page whose name changes in place updates the title', () => {
    // Money stays mounted across its four views, so a new view is a new name
    // on the same claim rather than a new claim.
    const { doc, claims } = harness();
    claims.claim(1, 'Money');
    claims.release(1);
    claims.claim(1, 'Recurring');
    expect(doc.title).toBe('Recurring · Scani');
  });

  test('releasing the last claim restores nothing — the next route sets its own', () => {
    const { doc, claims } = harness();
    claims.claim(1, 'Vaults');
    claims.release(1);
    expect(doc.title).toBe('Vaults · Scani');
  });

  test('the brand is the app’s to set', () => {
    const { doc, claims } = harness('Scani Cloud');
    claims.claim(1, 'API keys');
    expect(doc.title).toBe('API keys · Scani Cloud');
  });

  test('no document means nothing to write, not a throw', () => {
    const claims = createDocumentTitleClaims(() => undefined);
    expect(() => claims.claim(1, 'Holdings')).not.toThrow();
  });
});

describe('every peek names its record', () => {
  /**
   * The five peek routes (`/holdings/<id>`, `/accounts/<id>`, `/payments/<id>`
   * and the rest) are one component, so one claim covers all of them. Radix
   * renders nothing under `renderToStaticMarkup`, which is why this reads the
   * source rather than a render: it pins that the claim is the loaded record's
   * title and only while the sheet is open — not "Loading…", and not a closed
   * sheet's stale name.
   */
  test('PeekSheet claims the spec title while open, and nothing otherwise', async () => {
    const source = await Bun.file(
      join(import.meta.dir, '..', '..', 'src', 'v3', 'components', 'PeekSheet.tsx')
    ).text();
    expect(source).toContain('useDocumentTitle(open && spec ? spec.title : null);');
  });
});
