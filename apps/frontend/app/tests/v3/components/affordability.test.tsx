import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { Decimal, type ObservedAffordability } from '@scani/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { AffordabilityPanel } from '../../../src/v3/components/money/AffordabilityPanel';
import type { Affordability } from '../../../src/v3/lib/forecast';

/**
 * SC-661. "Can I afford it" is answered against OBSERVED burn (mgrin's call),
 * and this file covers the path a reader actually reaches — the one that only
 * renders once they have typed an amount, which is why `ForecastView`'s own
 * render tests cannot see it: `oneOff` is component state with no way in.
 *
 * ## Why the model changed rather than being kept alongside
 *
 * `affordability()` walks the committed book and returns `monthsLost: null`
 * unless BOTH walks run out inside twelve months. The account this was measured
 * against nets a positive figure every month, so neither ever did and the panel
 * could only answer "affordable",
 * whatever he typed into it. A control that cannot return a second answer is
 * not a control.
 */

const verdict = (over: Partial<ObservedAffordability> = {}): ObservedAffordability => ({
  monthsBefore: 8,
  monthsAfter: 5,
  monthsLost: 3,
  remaining: new Decimal('70000'),
  affordable: true,
  ...over,
});

function render(over: Record<string, unknown> = {}) {
  return renderToStaticMarkup(
    <AffordabilityPanel
      oneOff={{ date: '2026-09-01', currencyTokenId: 'token-usd', amount: '30000' }}
      onChange={() => {}}
      verdict={null}
      observedVerdict={verdict()}
      baseSymbol="USD"
      tokens={[]}
      {...over}
    />
  );
}

describe('SC-661 — affordability answers against observed burn', () => {
  test('it costs the purchase in months, which the walk could not', () => {
    const html = render();

    expect(html).toInclude('It costs 3 months of runway.');
    expect(html).toInclude('About 5 months at recent spending.');
    expect(html).toInclude('$70,000.00');
  });

  /**
   * The date field is still collected — it is part of the form's shape and a
   * reader fills it in — but it does not reach the answer. Saying so is
   * cheaper than a reader concluding the timing was considered, and it is the
   * real thing given up by moving off the schedule.
   */
  test('it admits it cannot tell a purchase now from one later', () => {
    const html = render();

    expect(html).toInclude('cannot tell a purchase now from one later in the year');
    // The committed answer named a MONTH. There is no month here, because a
    // mean over six months has no schedule to name one from.
    expect(html).not.toInclude('Lowest the balance gets');
    expect(html).not.toMatch(/In (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/);
  });

  test('a purchase bigger than the balance says so, and leaves no runway', () => {
    const html = render({
      observedVerdict: verdict({
        monthsAfter: 0,
        monthsLost: 8,
        remaining: new Decimal('-87296.88'),
        affordable: false,
      }),
    });

    expect(html).toInclude('That is more than the liquid balance.');
    expect(html).toInclude('About 0 months at recent spending.');
  });

  /**
   * THE STRUCTURAL ONE. Two answers to "can I afford it" on one panel is this
   * ticket's own contradiction, one screen further in. The observed verdict
   * REPLACES the walk; it never sits beside it.
   */
  test('the two models never answer at once', () => {
    const walk: Affordability = {
      lowest: { month: '2026-09', balance: new Decimal('4000') },
      affordable: true,
      runwayBefore: { kind: 'lasts', beyondMonths: 12, netPerMonth: new Decimal('789') },
      runwayAfter: { kind: 'lasts', beyondMonths: 12, netPerMonth: new Decimal('789') },
      monthsLost: null,
    };
    const html = render({ verdict: walk });

    expect(html).toInclude('It costs 3 months of runway.');
    // The walk's own tile and sentence, which must not appear beside it.
    expect(html).not.toInclude('Lowest the balance gets');
    expect(html).not.toInclude('The balance stays above zero');
  });

  test('with no observed verdict the walk still answers', () => {
    // The account with a recurring book and no perimeter exits. The relaxation
    // is conditional, not a removal — this is the control for the test above.
    const walk: Affordability = {
      lowest: { month: '2026-09', balance: new Decimal('4000') },
      affordable: true,
      runwayBefore: { kind: 'lasts', beyondMonths: 12, netPerMonth: new Decimal('789') },
      runwayAfter: { kind: 'lasts', beyondMonths: 12, netPerMonth: new Decimal('789') },
      monthsLost: null,
    };
    const html = render({ verdict: walk, observedVerdict: null });

    expect(html).toInclude('Lowest the balance gets');
    expect(html).not.toInclude('It costs 3 months of runway.');
  });
});
