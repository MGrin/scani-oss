import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { Sheet } from '@scani/ui/ui/sheet';
import { PeekHeader } from '@scani/ui/v3/components/PeekSheet';
import { renderToStaticMarkup } from 'react-dom/server';

/**
 * SC-1002 — every detail route names the record in its top-level heading.
 *
 * The five detail routes reach that heading two different ways, and the
 * difference is why this was misread as a heading-level bug on three of them:
 *
 *   /groups/<id>, /vaults/<id>      a routed page. Its own `h1` is the record.
 *   /holdings/<id>, /accounts/<id>,
 *   /payments/<id>                  a modal peek over the list page.
 *
 * On the second kind the list page's `h1` still says "Holdings" — and Radix
 * marks the surface behind an open dialog `aria-hidden`, so no assistive
 * technology reaches it. Measured on `demo.scani.xyz` 2026-09-04: on all three
 * the `h1` sat inside `main[aria-hidden="true"]` while the peek was open.
 *
 * **`document.querySelector('h1')` is the wrong instrument for this claim.**
 * It reads the DOM, which has no notion of `aria-hidden`, so it returns the
 * section name and reports a heading nothing can announce. The question is
 * about the accessibility tree, and the right probe skips hidden subtrees:
 *
 *     [...document.querySelectorAll('h1')]
 *       .find((e) => !e.closest('[aria-hidden="true"]'))
 *
 * Whoever audits this next will reach for the plain selector; that is the
 * reading to distrust, not the code.
 */

const PAGES = join(import.meta.dir, '..', '..', 'src', 'v3', 'pages');

async function pageSource(name: string): Promise<string> {
  return Bun.file(join(PAGES, `${name}.tsx`)).text();
}

describe('detail routes name the record, not the section', () => {
  /**
   * The three peek routes at once. Every v3 peek renders its identity through
   * `PeekHeader`, so there is one heading to get right rather than three.
   */
  test('a peek titles itself with an h1, so its outline has a top level', () => {
    const html = renderToStaticMarkup(
      <Sheet open>
        <PeekHeader spec={{ title: 'GBP', subtitle: 'British Pound · Revolut', primary: [] }} />
      </Sheet>
    );
    expect(html).toInclude('<h1');
    expect(html).toInclude('GBP');
    // An `h2` here is a subsection of the list page's `h1`, which is
    // `aria-hidden` — a level that leads nowhere.
    expect(html).not.toInclude('<h2');
  });

  /**
   * The controls, and they are the half that makes the test worth having.
   *
   * These two routes were already correct, so any change that "fixes" the
   * other three by moving the record name onto the *list* page's heading —
   * the reading of the acceptance that a plain `querySelector('h1')` invites —
   * has to leave these alone. They are routed pages with no dialog, so their
   * `h1` is reached directly and binds to the record.
   */
  test.each([
    ['GroupDetailPage', 'group.name'],
    ['VaultDetailPage', 'vault.name'],
  ])('%s puts the record in its own h1', async (page, binding) => {
    const source = await pageSource(page);
    expect(source).toContain(`<h1 className="min-w-0 truncate text-title">{${binding}}</h1>`);
  });

  /**
   * The other direction. A list page's `h1` is the *section*, and that is
   * correct — `/holdings` with no peek open is the holdings list. Rewriting it
   * to the record's name while a dialog covers it would break the one route
   * where it reads right today, which is why the peek owns its own heading
   * instead.
   */
  test('the holdings list keeps the section in its own h1', async () => {
    const source = await pageSource('HoldingsPage');
    expect(source).toContain('<h1 className="text-title">{t(\'v3.holdings.page.title\')}</h1>');
  });
});
