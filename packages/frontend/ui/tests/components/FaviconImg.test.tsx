import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { FaviconImg } from '../../src/components/FaviconImg';

/**
 * SC-1699: a row whose icon is still in flight showed an empty box, so a
 * Kraken account sat beside a lettered YNAB one with nothing in its mark.
 * The initial render is the in-flight state: no `load` has fired yet.
 */
describe('FaviconImg while its icon loads (SC-1699)', () => {
  const render = (fallbackClassName?: string) =>
    renderToStaticMarkup(
      <FaviconImg
        src="https://api.example/institution-icons/1"
        name="kraken"
        className="size-5"
        fallbackClassName={fallbackClassName}
      />
    );

  test('with a fallback, the letter shows until the image has loaded', () => {
    const html = render('tile');
    expect(html).toMatch(/<span class="tile" aria-hidden="true">K<\/span>/);
  });

  test('the image is still requested, but hidden until it loads', () => {
    const html = render('tile');
    expect(html).toMatch(/<img[^>]*src="https:\/\/api\.example\/institution-icons\/1"/);
    expect(html).toMatch(/<img[^>]*class="[^"]*\bhidden\b/);
  });

  test('without a fallback, nothing changes: the bare image', () => {
    const html = render();
    expect(html).not.toContain('<span');
    expect(html).not.toMatch(/\bhidden\b/);
  });
});
