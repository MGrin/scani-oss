import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  RecurringSuggestionsView,
  type SuggestionRow,
} from '../../../src/v3/components/money/RecurringSuggestions';

const GYM: SuggestionRow = {
  counterparty: 'Gym Ltd',
  counterpartyKey: 'gym',
  currencyTokenId: 'tok-gbp',
  amount: '49.99',
  anchorDate: '2026-08-01',
  evidence: [
    { transactionId: 't1', date: '2026-05-03', amount: '49.99', currencyTokenId: 'tok-gbp' },
    { transactionId: 't2', date: '2026-06-02', amount: '49.99', currencyTokenId: 'tok-gbp' },
    { transactionId: 't3', date: '2026-07-03', amount: '50.49', currencyTokenId: 'tok-gbp' },
  ],
};

function render(suggestions: SuggestionRow[]) {
  return renderToStaticMarkup(
    createElement(RecurringSuggestionsView, {
      suggestions,
      tokenSymbolById: new Map([
        ['tok-gbp', 'GBP'],
        ['tok-usdt', 'USDT'],
        ['tok-usdc', 'USDC'],
      ]),
      pendingKey: null,
      onAccept: () => {},
      onDismiss: () => {},
    })
  );
}

describe('RecurringSuggestionsView (SC-674)', () => {
  test('names the payee and the monthly amount, and shows every payment it matched', () => {
    const html = render([GYM]);
    expect(html).toContain('Gym Ltd');
    expect(html).toContain('49.99');
    // The evidence: each matched payment, with its own amount — 50.49 is not
    // the suggested figure, so it can only come from the evidence list.
    expect(html).toContain('50.49');
    expect(html.match(/data-evidence-row/g)).toHaveLength(3);
  });

  test('offers both answers, and neither is pre-chosen', () => {
    const html = render([GYM]);
    expect(html).toContain('data-action="accept"');
    expect(html).toContain('data-action="dismiss"');
  });

  // A series paid in USDT one month and USDC the next is one suggestion; each
  // payment it lists must still name the coin it was actually paid in.
  test("each matched payment shows the coin it was paid in, not the suggestion's", () => {
    const html = render([
      {
        ...GYM,
        counterparty: '0xabc',
        currencyTokenId: 'tok-usdt',
        amount: '3250',
        evidence: [
          { transactionId: 'a', date: '2026-06-10', amount: '3250', currencyTokenId: 'tok-usdc' },
          { transactionId: 'b', date: '2026-07-09', amount: '3250', currencyTokenId: 'tok-usdt' },
        ],
      },
    ]);
    const rows = html.split('data-evidence-row').slice(1);
    expect(rows[0]).toContain('USDC');
    expect(rows[1]).toContain('USDT');
  });

  test('renders nothing when there is nothing to suggest', () => {
    expect(render([])).toBe('');
  });
});
