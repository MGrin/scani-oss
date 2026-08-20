import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import i18n from 'i18next';
import { renderToStaticMarkup } from 'react-dom/server';
import { Trans } from 'react-i18next';

/**
 * The last string SC-202 had left to extract, and the only one in v3 that had
 * to become a `<Trans>` rather than a `t()`: the figure it names is a rendered
 * `<Numeric>` sitting INSIDE the sentence, not a value that can be
 * interpolated as text.
 *
 * Splitting it into two `t()` halves with the component between them is the
 * thing this guards against. It would hand a translator two fragments and pin
 * English word order into the JSX — no language is obliged to put the amount
 * between "recorded against it" and "comes off your portfolio total" — and
 * the two halves would each look fully translated while the sentence they
 * make was never translatable at all.
 *
 * Rendered rather than asserted against the JSON, because a key can exist,
 * read correctly, and still produce nothing: `<Trans>` drops a slot whose name
 * is absent from `components`, and does it silently. The failure mode is a
 * sentence with a hole in it where the money was, which is exactly the sort of
 * thing that survives review and reaches a confirmation dialog for deleting a
 * holding.
 */
describe('v3.holdings.deleteAction.consequence', () => {
  const render = (value: string) =>
    renderToStaticMarkup(
      <Trans
        i18nKey="v3.holdings.deleteAction.consequence"
        values={{ symbol: 'BTC', account: 'Kraken' }}
        components={{ value: <span data-testid="figure">{value}</span> }}
      />
    );

  test('the key exists — a missing one renders as its own name', () => {
    const raw = i18n.t('v3.holdings.deleteAction.consequence');
    expect(raw).not.toBe('v3.holdings.deleteAction.consequence');
    expect(raw).toContain('comes off your portfolio total');
  });

  test('renders one whole sentence with both values and the figure in place', () => {
    const html = render('$1,234.56');
    expect(html).toContain('BTC in Kraken is removed');
    expect(html).toContain('$1,234.56');
    expect(html).toContain('comes off your portfolio total');
    expect(html).toContain('use Deactivate');
  });

  test('the figure sits BETWEEN the two halves, not before or after them', () => {
    // The property that makes this a sentence rather than three strings that
    // happen to be adjacent. If the slot were dropped and the figure appended,
    // every assertion above would still pass.
    const html = render('$1,234.56');
    const before = html.indexOf('recorded against it');
    const figure = html.indexOf('$1,234.56');
    const after = html.indexOf('comes off your portfolio total');
    expect(before).toBeGreaterThan(-1);
    expect(figure).toBeGreaterThan(before);
    expect(after).toBeGreaterThan(figure);
  });

  test('no interpolation placeholder survives into the output', () => {
    // `{{symbol}}` reaching a screen is the failure this whole extraction
    // exists to avoid, and it is invisible to a test that only greps for prose.
    const html = render('$1,234.56');
    expect(html).not.toContain('{{');
    expect(html).not.toContain('<value');
  });
});
