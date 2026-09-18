import { describe, expect, test } from 'bun:test';
import { formatCurrency, resetFormatLocale, setFormatLocale } from '@scani/shared';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import { renderToStaticMarkup } from 'react-dom/server';

// Static markup rather than a DOM: the repo has no DOM test environment, and
// what these tests are protecting is the rendered output — the classes that
// carry the token, and the characters that carry the direction without it.

describe('Numeric — the numeric type role', () => {
  test('every figure is monospaced, tabular and tracked, without the call site asking', () => {
    const html = renderToStaticMarkup(<Numeric value={1234.5} currency="USD" />);
    expect(html).toInclude('font-mono');
    expect(html).toInclude('tabular-nums');
    expect(html).toInclude('tracking-numeric');
    expect(html).toInclude('$1,234.50');
  });

  test('sets no font size — the role is a treatment and the caller owns the scale', () => {
    const html = renderToStaticMarkup(
      <Numeric value={1} currency="USD" className="text-display" />
    );
    expect(html).toInclude('text-display');
    expect(html).not.toMatch(/text-(label|caption|body|title)\b/);
  });

  test('passes span attributes through', () => {
    const html = renderToStaticMarkup(<Numeric value={1} currency="USD" data-testid="total" />);
    expect(html).toInclude('data-testid="total"');
  });
});

describe('Numeric — gain and loss are never colour alone', () => {
  test('a gain carries the token, a sign and an arrow', () => {
    const html = renderToStaticMarkup(<Numeric value={1234.5} currency="USD" delta />);
    expect(html).toInclude('text-gain');
    expect(html).toInclude('+$1,234.50');
    expect(html).toInclude('↑');
  });

  test('a loss carries the token, a sign and an arrow', () => {
    const html = renderToStaticMarkup(<Numeric value={-1234.5} currency="USD" delta />);
    expect(html).toInclude('text-loss');
    expect(html).toInclude('−$1,234.50');
    expect(html).toInclude('↓');
  });

  test('zero takes the neutral token, not the gain one', () => {
    const html = renderToStaticMarkup(<Numeric value={0} currency="USD" delta />);
    expect(html).toInclude('text-neutral');
    expect(html).not.toInclude('text-gain');
    expect(html).not.toInclude('↑');
  });

  // The whole point of the component: v2 encoded direction as
  // `text-green-600` / `text-red-600` with no second channel, in 47 places.
  test.each([
    1234.5, -1234.5,
  ])('the direction of %p survives with every colour stripped', (value) => {
    const html = renderToStaticMarkup(<Numeric value={value} currency="USD" delta />);
    const withoutColour = html.replace(/class="[^"]*"/g, '');
    expect(withoutColour).toMatch(value > 0 ? /[+↑]/ : /[−↓]/);
  });

  test('indicator="sign" drops the arrow and keeps the sign', () => {
    const html = renderToStaticMarkup(
      <Numeric value={-1234.5} currency="USD" delta indicator="sign" />
    );
    expect(html).not.toInclude('↓');
    expect(html).toInclude('−$1,234.50');
  });

  test('the arrow is hidden from assistive tech, which reads the sign instead', () => {
    const html = renderToStaticMarkup(<Numeric value={5} currency="USD" delta />);
    expect(html).toInclude('<span aria-hidden="true">↑');
  });

  test('a magnitude takes no gain/loss token even when negative', () => {
    const html = renderToStaticMarkup(<Numeric value={-1234.5} currency="USD" />);
    expect(html).not.toInclude('text-loss');
    expect(html).not.toInclude('↓');
    expect(html).toInclude('−$1,234.50');
  });
});

describe('Numeric — the placeholder', () => {
  test('an absent value says so in words as well as a dash', () => {
    const html = renderToStaticMarkup(<Numeric value={null} currency="USD" />);
    expect(html).toInclude('<span aria-hidden="true">—</span>');
    expect(html).toInclude('No value');
    expect(html).toInclude('sr-only');
  });

  test('the placeholder is muted, not toned', () => {
    const html = renderToStaticMarkup(<Numeric value={null} currency="USD" delta />);
    expect(html).toInclude('text-muted-foreground');
    expect(html).not.toInclude('text-neutral');
  });
});

describe('Numeric — formats', () => {
  test('percent', () => {
    expect(renderToStaticMarkup(<Numeric value={4.213} format="percent" delta />)).toInclude(
      '+4.21%'
    );
  });

  test('percent at one decimal', () => {
    expect(renderToStaticMarkup(<Numeric value={4.213} format="percent" decimals={1} />)).toInclude(
      '4.2%'
    );
  });

  test('plain, for a unit count where the currency lives elsewhere on the row', () => {
    expect(renderToStaticMarkup(<Numeric value={1500.5} format="plain" />)).toInclude('1,500.5');
  });

  test('compact, for a chart axis or a summary tile', () => {
    expect(renderToStaticMarkup(<Numeric value={12_800} currency="USD" compact />)).toInclude(
      '$12.8K'
    );
  });
});

/**
 * SC-1229: under `dir="rtl"`, `US$ 193,150.00` rendered as `$US 193,150.00` —
 * the currency's own symbol split in two, the `$` thrown to the far side of
 * `US`. Every money figure in the holdings table and the value card.
 *
 * The mechanism is in the STRING, not in the layout, which is why these tests
 * can assert it without a DOM. ICU returns `U+200F 193,150.00 U+00A0 US$` for
 * Arabic: the symbol TRAILS. A trailing `$` is a European terminator with no
 * digit beside it, so it degrades to a neutral; sitting between `US` (L) and
 * the end of an RTL paragraph (R) it takes the embedding direction and is laid
 * out to the LEFT of `US`. English never shows this because its symbol LEADS,
 * where it is adjacent to the digits and takes their direction.
 */
describe('Numeric — money is an LTR island under RTL (SC-1229)', () => {
  const arabic = <T,>(f: () => T): T => {
    try {
      setFormatLocale('ar');
      return f();
    } finally {
      resetFormatLocale();
    }
  };

  test('the mechanism: the Arabic string trails its symbol behind a leading RLM', () => {
    const s = arabic(() => formatCurrency(193_150, 'USD'));
    // U+200F RLM, and it is what makes `<bdi>` the WRONG fix: `<bdi>` is
    // `dir="auto"`, which resolves from the first STRONG character — this one —
    // so it would isolate the token and still lay it out RTL.
    expect(s.codePointAt(0)).toBe(0x200f);
    expect(s).toMatch(/US\$$/);
  });

  test('CONTROL: English needs no island — its symbol leads and never splits', () => {
    expect(formatCurrency(193_150, 'USD')).toBe('$193,150.00');
  });

  test('the money token is wrapped in an explicit dir="ltr", not left to the paragraph', () => {
    const { html, figure } = arabic(() => ({
      html: renderToStaticMarkup(<Numeric value={193_150} currency="USD" />),
      figure: formatCurrency(193_150, 'USD'),
    }));
    // The island must wrap the FIGURE, so this asserts the pair together rather
    // than `dir="ltr"` appearing anywhere in the markup.
    expect(html).toInclude(`<span dir="ltr">${figure}</span>`);
  });

  /**
   * The hazard this fix must not introduce, and the reason the island wraps the
   * text ALONE. `NetWorthTape.tsx` records it (SC-201): with an arrow, a
   * `Numeric` is two nodes, and the arrow is a NEUTRAL that takes the paragraph
   * direction so it lands at the READING start in either one. Pull it inside an
   * LTR island and it pins to the physical left — the reading END of an Arabic
   * line, which is the defect, reintroduced by the fix for a different one.
   */
  test('the arrow stays OUTSIDE the island, so it still lands at the reading start', () => {
    const html = renderToStaticMarkup(<Numeric value={1234.5} currency="USD" delta />);
    const arrow = html.indexOf('↑');
    const island = html.indexOf('dir="ltr"');
    expect(arrow).toBeGreaterThan(-1);
    expect(island).toBeGreaterThan(-1);
    expect(arrow).toBeLessThan(island);
  });

  test('a placeholder has no island — there is no figure to isolate', () => {
    const html = arabic(() => renderToStaticMarkup(<Numeric value={null} currency="USD" />));
    expect(html).not.toInclude('dir="ltr"');
  });
});
