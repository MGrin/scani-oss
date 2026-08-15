import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Numeric } from '../../src/v3/components/Numeric';
import { FIGURE_ADVANCE, figureCells, figureFitStyle } from '../../src/v3/lib/figure';

/**
 * The figure-fit contract (SC-72).
 *
 * The CSS half is asserted in `@scani/ui`'s `v3-figure-fit.test.ts`; this is the
 * half a component supplies. The two only agree if the cell count matches what
 * is actually rendered, so the assertions below are about exactly that: what
 * `<Numeric>` publishes and what it prints have to be the same run.
 */

/** The measured advance, asserted so the CSS divisor cannot drift from it. */
const MEASURED_ADVANCE = 0.59;

function cellsOf(markup: string): number {
  return Number(markup.match(/--figure-cells:\s*([\d.]+)/)?.[1]);
}

/**
 * Everything inside the fit span with the tags taken out — the run as it will
 * be set. No entity decoding: React escapes only `&<>"'`, none of which a
 * formatted figure contains, and the arrow, the minus and the thin space all
 * come through as themselves.
 */
function runOf(markup: string): string {
  const inner = markup.match(/data-figure-fit="true"[^>]*>(.*)<\/span><\/span>$/s)?.[1] ?? '';
  return inner.replace(/<[^>]*>/g, '');
}

describe('figureCells', () => {
  test('counts every glyph, because every glyph is one cell in a mono face', () => {
    expect(figureCells('$1,234.56')).toBe(9);
  });

  test('counts a code point once, not its UTF-16 units', () => {
    // `.length` would say 2 and reserve a cell the figure does not occupy.
    expect(figureCells('\u{1D7D8}')).toBe(1);
  });
});

describe('figureFitStyle', () => {
  test('publishes the cell count the CSS divides by', () => {
    expect(figureFitStyle(9)).toEqual({ '--figure-cells': 9 } as never);
  });

  test('omits the inset entirely rather than sending a zero', () => {
    // The CSS default is `0px`; sending `undefined` through would serialise as
    // nothing useful, and sending `0` would be a length-less zero in a `calc`.
    expect('--figure-inset' in figureFitStyle(9)).toBe(false);
    expect(figureFitStyle(9, 'calc(1px)')).toHaveProperty('--figure-inset', 'calc(1px)');
  });
});

describe('the nominal advance', () => {
  test('is never narrower than the measured one, so the fit errs small', () => {
    // 0.6em of glyph less 0.01em of `--text-numeric-tracking` is what the face
    // actually sets. Using the nominal figure costs ~1.7% of type size and
    // covers the fallback mono faces, which are no narrower.
    expect(FIGURE_ADVANCE).toBeGreaterThanOrEqual(MEASURED_ADVANCE);
    expect(FIGURE_ADVANCE - MEASURED_ADVANCE).toBeLessThan(0.02);
  });
});

describe('<Numeric> publishes the run it prints', () => {
  test.each([
    ['a plain magnitude', <Numeric key="a" value={1234.56} currency="USD" />],
    ['a long weak-currency total', <Numeric key="b" value={142742530.04} currency="IDR" />],
    ['a delta, whose arrow and thin space are cells too', <Numeric key="c" value={-12.5} delta />],
    ['a percentage', <Numeric key="d" value={12.5} format="percent" />],
  ])('%s', (_name, element) => {
    const markup = renderToStaticMarkup(element);
    expect(cellsOf(markup)).toBe(figureCells(runOf(markup)));
  });

  test('the fit sits inside the type role, never on it', () => {
    // `1em` in the size rule has to resolve to the size the caller asked for.
    // On the same element it would resolve to the *parent's* size and quietly
    // shrink every hero to body text.
    const markup = renderToStaticMarkup(
      <Numeric className="text-display" value={1234.56} currency="USD" />
    );
    expect(markup.indexOf('text-display')).toBeLessThan(markup.indexOf('data-figure-fit'));
  });

  test('a placeholder needs no fit — one em dash cannot overflow anything', () => {
    const markup = renderToStaticMarkup(<Numeric value={null} currency="USD" />);
    expect(markup).not.toContain('data-figure-fit');
  });
});
