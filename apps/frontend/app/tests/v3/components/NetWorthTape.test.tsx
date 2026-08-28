import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { NetWorthTape } from '../../../src/v3/components/home/NetWorthTape';

/**
 * The roll itself is not testable here — it needs two renders and a committed
 * effect, and the repo has no DOM test environment (see `charts.test.tsx`).
 * What server rendering *can* pin is the part the design brief is specific
 * about: which glyph ends up in which band, that the grouping is a gap rather
 * than a comma, and that a screen reader hears a figure rather than a run of
 * separately-positioned cells. The motion is verified by screenshot.
 */

const render = (value: unknown, currency = 'USD') =>
  renderToStaticMarkup(<NetWorthTape value={value as number} currency={currency} />);

describe('NetWorthTape', () => {
  test('the integer run carries the display size and the demoted parts do not', () => {
    const html = render('128432.10');
    expect(html).toInclude('font-display text-display');
    // Symbol and cents are caption-sized and muted — §5.4.
    expect(html.match(/text-caption text-muted-foreground/g)).toHaveLength(2);
  });

  test('every digit gets its own one-cell column', () => {
    // `128,432` — six digits, each in a `1ch` cell so a digit can be replaced
    // in place without the figure reflowing.
    expect(render('128432.10').match(/width:1ch/g)).toHaveLength(6);
  });

  test('thousands take the ordinary separator, in a cell narrower than a digit', () => {
    // SC-71 6.2. The separator used to be a *blank* of this width, so the hero
    // printed `€602 641.80` beside a delta chip reading `+€7,209.93` — the only
    // finding all three QA surfaces reported independently. What the monospace
    // argument buys is the narrow cell, not the missing glyph.
    const html = render('128432.10');
    expect(html).toInclude('width:0.4ch');
    const visible = html.slice(html.indexOf('aria-hidden'));
    expect(visible).toInclude('style="width:0.4ch"');
    expect(visible.match(/,/g)).toHaveLength(1);
  });

  test('a screen reader hears the ordinary figure', () => {
    const html = render('128432.10');
    expect(html).toInclude('<span class="sr-only">$128,432.10</span>');
    // …and nothing else: the composed glyphs are hidden from it.
    expect(html).toInclude('aria-hidden="true"');
  });

  test('an unknown total renders as a placeholder, not as zero', () => {
    const html = render(null);
    expect(html).toInclude('—');
    expect(html).toInclude('<span class="sr-only">No value</span>');
    expect(html).not.toInclude('0.00');
  });

  test('nothing rolls on the first render', () => {
    expect(render('128432.10')).not.toInclude('v3-tape-roll');
  });

  test('a non-ISO token symbol renders rather than throwing', () => {
    expect(render('4200', 'PRIVATECO')).toInclude('PRIVATECO');
  });

  /**
   * SC-760. The hero is COMPOSED, not printed — a flex row of symbol, digit run
   * and cents, whose digit run is itself a row of one-glyph cells. The bidi
   * algorithm keeps a single formatted string like `$193,150.00` left-to-right
   * in an RTL paragraph, which is why `<Numeric>` needs nothing; it cannot do
   * that for elements, so under `dir="rtl"` all three columns AND the digits
   * inside them reverse. A phone screenshot caught it rendering `00.051,391 $`.
   *
   * Pinned here rather than left to the RTL baseline because the baseline shows
   * it only on the one screen that happens to photograph the hero.
   */
  test('the composed figure is pinned left-to-right, whatever the document is', () => {
    const html = render('128432.10');
    expect(html).toInclude('aria-hidden="true" dir="ltr"');
    // The accessible string is NOT pinned: it is ordinary localised prose and
    // belongs to the document's direction. If this ever starts matching, the
    // attribute has been hoisted somewhere it should not be.
    const srOnly = html.slice(0, html.indexOf('aria-hidden'));
    expect(srOnly).not.toInclude('dir="ltr"');
  });
});
