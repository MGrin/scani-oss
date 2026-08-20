import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import i18n from 'i18next';
import { renderToStaticMarkup } from 'react-dom/server';
import { Trans } from 'react-i18next';

/**
 * The sentences SC-235 restructured, rendered.
 *
 * Every one of these was built the same way: a `t()` half, a rendered figure,
 * a second `t()` half. Each half read correctly in `en.json` and the sentence
 * they made was untranslatable — a translator could rewrite both sides and
 * still not move the amount, because the amount's position was in the JSX.
 *
 * **Rendered rather than asserted against the JSON**, for the reason
 * `holdingDeleteConsequence.test.tsx` gives: `<Trans>` drops a slot whose name
 * is absent from `components` and does it silently, so a key can exist, read
 * correctly and still produce a sentence with a hole where the money was.
 *
 * The ORDER assertions are the load-bearing ones. Without them a dropped slot
 * and an appended figure pass every content check.
 */

/** Where each piece landed, so order can be asserted without index arithmetic
 *  at every call site. */
function order(html: string, ...needles: string[]): number[] {
  return needles.map((n) => html.indexOf(n));
}

function isAscending(positions: number[]): boolean {
  return positions.every((p, i) => p > -1 && (i === 0 || p > (positions[i - 1] ?? -1)));
}

/**
 * A slot `<Trans>` could not fill.
 *
 * It does not throw and it does not render empty — it renders the slot's own
 * tag as TEXT, HTML-escaped: `&amp;lt;value/&gt;`. So a check for `"<value"`
 * passes over exactly the failure it was written to catch, which is why this
 * matches the escaped form too.
 */
function expectEverySlotFilled(html: string): void {
  expect(html).not.toMatch(/(?:&lt;|lt;|<)\/?(?:value|qty|label)\s*\/?\s*(?:&gt;|gt;|>)/);
  expect(html).not.toContain('{{');
}

describe('the figure sits inside the sentence, not between two halves of one', () => {
  test('v3.holdings.summary.excludes — both plural forms, figure in the middle', () => {
    const render = (count: number) =>
      renderToStaticMarkup(
        <Trans
          i18nKey="v3.holdings.summary.excludes"
          count={count}
          components={{ value: <span>€3,658.00</span> }}
        />
      );

    const one = render(1);
    expect(one).toContain('Excludes 1 inactive holding worth');
    expect(isAscending(order(one, 'worth', '€3,658.00', 'still listed below'))).toBe(true);

    const many = render(2);
    expect(many).toContain('Excludes 2 inactive holdings worth');
    expect(isAscending(order(many, 'worth', '€3,658.00', 'still listed below'))).toBe(true);

    for (const html of [one, many]) expectEverySlotFilled(html);
  });

  test('v3.holdings.status.{deactivate,activate}Consequence', () => {
    const render = (key: string) =>
      renderToStaticMarkup(
        <Trans
          i18nKey={key}
          values={{ symbol: 'LINK', account: 'Kraken Earn' }}
          components={{ value: <span>€3,658.00</span> }}
        />
      );

    const off = render('v3.holdings.status.deactivateConsequence');
    expect(off).toContain('LINK in Kraken Earn stops counting');
    expect(isAscending(order(off, 'portfolio total', '€3,658.00', 'comes off it'))).toBe(true);
    expect(off).toContain('listed here as Inactive');

    const on = render('v3.holdings.status.activateConsequence');
    expect(on).toContain('LINK in Kraken Earn counts toward');
    expect(isAscending(order(on, 'again', '€3,658.00', 'goes back on it'))).toBe(true);

    for (const html of [off, on]) expectEverySlotFilled(html);
  });

  test('v3.vaults.holding.detachConsequence — symbol, figure and share all placed', () => {
    const html = renderToStaticMarkup(
      <Trans
        i18nKey="v3.vaults.holding.detachConsequence"
        values={{ symbol: 'EUR', percent: 50 }}
        components={{ value: <span>€24,125.00</span> }}
      />
    );
    expect(html).toContain('EUR stops counting toward this vault');
    expect(isAscending(order(html, 'this vault', '€24,125.00', 'comes off the saved figure'))).toBe(
      true
    );
    expect(html).toContain('50% share');
    expectEverySlotFilled(html);
  });

  test('v3.review.list.valueAwaiting — with and without the unpriced clause', () => {
    const render = (key: string, count: number) =>
      renderToStaticMarkup(
        <Trans
          i18nKey={key}
          count={count}
          components={{ label: <span />, value: <span>€800.00</span> }}
        />
      );

    const plain = render('v3.review.list.valueAwaiting', 0);
    expect(plain).toContain('Value awaiting an answer:');
    expect(plain).toContain('€800.00');
    expect(plain).not.toContain('no price that day');

    // The clause that used to be a sibling key opening with " · ". A language
    // that leads with it now can: it is inside the sentence.
    const one = render('v3.review.list.valueAwaitingUnpriced', 1);
    expect(
      isAscending(order(one, 'Value awaiting', '€800.00', '1 more with no price that day'))
    ).toBe(true);
    const many = render('v3.review.list.valueAwaitingUnpriced', 4);
    expect(many).toContain('4 more with no price that day');

    for (const html of [plain, one, many]) expectEverySlotFilled(html);
  });

  test('v3.common.baseEquivalent — seen and spoken are whole phrases, not a prefix and a suffix', () => {
    const render = (key: string) =>
      renderToStaticMarkup(<Trans i18nKey={key} components={{ value: <span>€49.73</span> }} />);

    // The two registers deliberately differ: the seen one uses a glyph where
    // the spoken one needs a word, and the stale note is a middot on screen
    // and a clause in the ear.
    expect(render('v3.common.baseEquivalent.seen')).toContain('€49.73');
    expect(render('v3.common.baseEquivalent.seenStale')).toContain('older rate');
    expect(render('v3.common.baseEquivalent.spoken')).toContain('About');
    const spokenStale = render('v3.common.baseEquivalent.spokenStale');
    expect(isAscending(order(spokenStale, 'About', '€49.73', 'at an older rate'))).toBe(true);

    for (const key of ['seen', 'seenStale', 'spoken', 'spokenStale']) {
      const html = render(`v3.common.baseEquivalent.${key}`);
      expect(html).toContain('€49.73');
      expectEverySlotFilled(html);
    }
  });

  test('v3.common.convertedFigure — each clause owns its figure', () => {
    const render = (key: string) =>
      renderToStaticMarkup(<Trans i18nKey={key} components={{ value: <span>£6,300.00</span> }} />);

    const seen = render('v3.common.convertedFigure.unconvertedSeen');
    expect(isAscending(order(seen, '£6,300.00', 'unconverted'))).toBe(true);
    // No `+` in the key: the separator between list items is markup, and a
    // translator has nothing to do with it.
    expect(seen).not.toContain('+');

    const noRate = render('v3.common.convertedFigure.unconvertedSpoken');
    expect(isAscending(order(noRate, '£6,300.00', 'no recent rate'))).toBe(true);

    const unavailable = render('v3.common.convertedFigure.unavailableSpoken');
    expect(isAscending(order(unavailable, '£6,300.00', 'could not be loaded'))).toBe(true);

    // The collapsed forms count currencies instead of naming figures, so they
    // are their own keys rather than the same string at another length.
    expect(i18n.t('v3.common.convertedFigure.moreCurrencies', { count: 1 })).toBe(
      '1 currency unconverted'
    );
    expect(i18n.t('v3.common.convertedFigure.moreCurrencies', { count: 3 })).toBe(
      '3 currencies unconverted'
    );
    expect(i18n.t('v3.common.convertedFigure.unconvertedSpokenMany', { count: 3 })).toContain(
      '3 currencies not converted'
    );
    expect(i18n.t('v3.common.convertedFigure.unavailableSpokenMany', { count: 3 })).toContain(
      'could not be loaded'
    );
  });

  test('v3.holdings.realized — three whole lot sentences and a cost clause', () => {
    const lot = (key: string) =>
      renderToStaticMarkup(
        <Trans
          i18nKey={key}
          values={{ date: '12 Aug 2026', duration: '8 months' }}
          components={{ qty: <span>0.5</span> }}
        />
      );

    const acquired = lot('v3.holdings.realized.lotAcquired');
    expect(isAscending(order(acquired, '0.5', 'acquired 12 Aug 2026'))).toBe(true);
    expect(acquired).not.toContain('held');

    const held = lot('v3.holdings.realized.lotHeld');
    expect(isAscending(order(held, '0.5', 'acquired 12 Aug 2026', 'held 8 months'))).toBe(true);

    const none = lot('v3.holdings.realized.lotNoAcquisition');
    expect(isAscending(order(none, '0.5', 'with no acquisition on record'))).toBe(true);
    expect(none).not.toContain('12 Aug 2026');

    const cost = renderToStaticMarkup(
      <Trans i18nKey="v3.holdings.realized.costOf" components={{ value: <span>€120.00</span> }} />
    );
    expect(isAscending(order(cost, 'cost', '€120.00'))).toBe(true);

    for (const html of [acquired, held, none, cost]) expectEverySlotFilled(html);
  });

  test('v3.review.transfer.answeredShort — the quantity is named, not prefixed', () => {
    // "0.5 disposed" glued a figure to the front of a bare participle. Each
    // verdict now interpolates `{{amount}}`, so a language that puts the
    // quantity last can.
    for (const verdict of ['paired', 'internal', 'leftControl', 'untracked']) {
      const key = `v3.review.transfer.answeredShort.${verdict}`;
      expect(i18n.t(key)).toContain('{{amount}}');
      expect(i18n.t(key, { amount: '0.5' })).toStartWith('0.5 ');
    }
  });
});

/**
 * The one shape a rendered sentence cannot prove: a clause whose subject is
 * the row it sits beside.
 *
 * `"Displays as USDC"` is complete-looking and has no subject — the badge
 * borrows one from the symbol to its left. English keeps that, because at
 * 390px this badge already competes with two others for the row and a
 * duplicated symbol is what loses. What changed is that `{{symbol}}` is now
 * PASSED, so a translator whose language cannot leave the subject out has one
 * to place.
 */
describe('the lookalike badge offers a subject English does not spend', () => {
  test('English is unchanged', () => {
    expect(i18n.t('v3.holdings.badge.lookalike', { symbol: 'UЅDС', impersonates: 'USDC' })).toBe(
      'Displays as USDC'
    );
  });

  test('a translation that names the subject resolves it', () => {
    // Proved by asking for the shape a Russian or Japanese translator would
    // write, against the same values the call site passes. Without `symbol` in
    // the interpolation this renders `{{symbol}}` at a reader.
    i18n.addResource(
      'en',
      'translation',
      'test.lookalikeWithSubject',
      '{{symbol}} displays as {{impersonates}}'
    );
    expect(i18n.t('test.lookalikeWithSubject', { symbol: 'UЅDС', impersonates: 'USDC' })).toBe(
      'UЅDС displays as USDC'
    );
  });
});
