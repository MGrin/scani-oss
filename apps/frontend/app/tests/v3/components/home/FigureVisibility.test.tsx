import '../../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  FigureVisibilityToggle,
  MaskedFigure,
  readFigureVisibility,
} from '../../../../src/v3/components/home/FigureVisibility';
import { amountTick, HIDDEN_TICK } from '../../../../src/v3/components/home/PortfolioChart';
import {
  VIEW_PREFERENCE_KEYS,
  viewPreferenceStorageKey,
} from '../../../../src/v3/lib/view-preference';

function storageWith(value: string | null) {
  const key = viewPreferenceStorageKey(VIEW_PREFERENCE_KEYS.homeFigureVisibility);
  return {
    getItem: (asked: string) => (asked === key ? value : null),
    setItem: () => {},
  };
}

/**
 * SC-1375 — the phone opens with the net-worth figure unreadable, the laptop
 * opens with it shown, and the difference is only what each device stored.
 */
describe('hero figure visibility', () => {
  test('a device that never chose opens shown', () => {
    expect(readFigureVisibility(storageWith(null))).toBe('shown');
  });

  test('a device that chose hidden opens hidden', () => {
    expect(readFigureVisibility(storageWith('hidden'))).toBe('hidden');
  });

  test('a value that is not an option opens shown rather than stranding the figure', () => {
    expect(readFigureVisibility(storageWith('blurred'))).toBe('shown');
  });

  test('hidden blurs the figure, hides it from a screen reader and says so instead', () => {
    const html = renderToStaticMarkup(<MaskedFigure hidden>$121,987.39</MaskedFigure>);
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('blur-md');
    expect(html).toContain('Amount hidden');
  });

  test('shown renders the figure untouched (control)', () => {
    const html = renderToStaticMarkup(<MaskedFigure hidden={false}>$121,987.39</MaskedFigure>);
    expect(html).toBe('$121,987.39');
  });

  test('the eye names the action it will take and reports its state', () => {
    const hidden = renderToStaticMarkup(<FigureVisibilityToggle hidden onToggle={() => {}} />);
    expect(hidden).toContain('aria-label="Show amount"');
    expect(hidden).toContain('aria-pressed="true"');
    const shown = renderToStaticMarkup(
      <FigureVisibilityToggle hidden={false} onToggle={() => {}} />
    );
    expect(shown).toContain('aria-label="Hide amount"');
    expect(shown).toContain('aria-pressed="false"');
  });

  test('the hero chart axis cannot give the hidden figure away', () => {
    const format = { compact: true, decimals: 1 } as const;
    expect(amountTick(220_300, { currency: 'GBP', hidden: true, ...format })).toBe(HIDDEN_TICK);
    // Control: shown, the same tick is the amount.
    expect(amountTick(220_300, { currency: 'GBP', hidden: false, ...format })).toContain('220');
  });

  test('while the setting is hidden, the blurred figure is a control that peeks', () => {
    const html = renderToStaticMarkup(
      <MaskedFigure hidden onPeek={() => {}}>
        $121,987.39
      </MaskedFigure>
    );
    expect(html).toContain('<button');
    expect(html).toContain('aria-label="Show amount"');
    expect(html).toContain('data-figure-masked');
  });

  test('a peeked figure stays a control, so a second tap hides it again', () => {
    const html = renderToStaticMarkup(
      <MaskedFigure hidden={false} onPeek={() => {}}>
        $121,987.39
      </MaskedFigure>
    );
    expect(html).toContain('<button');
    expect(html).toContain('$121,987.39');
    expect(html).not.toContain('data-figure-masked');
  });

  test('with the setting shown there is nothing to peek at (control)', () => {
    const html = renderToStaticMarkup(<MaskedFigure hidden={false}>$121,987.39</MaskedFigure>);
    expect(html).not.toContain('<button');
  });
});
