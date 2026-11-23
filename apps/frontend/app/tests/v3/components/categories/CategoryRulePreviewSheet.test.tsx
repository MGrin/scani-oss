import '../../../i18n-preload';
import { expect, test } from 'bun:test';
import type { RulePreview } from '@scani/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { CategoryRulePreviewBody } from '../../../../src/v3/components/categories/CategoryRulePreviewSheet';

const preview: RulePreview = {
  previewId: 'preview',
  expiresAt: '2026-11-23T12:15:00Z',
  scope: { accountId: 'a', from: '2026-11-01T00:00:00Z', to: '2026-12-01T00:00:00Z' },
  accountName: 'Everyday',
  matched: 4,
  protected: 1,
  unchanged: 1,
  changed: 2,
  rows: ['USD', 'EUR'].map((currency, i) => ({
    transactionId: String(i),
    occurredAt: '2026-11-10T12:00:00Z',
    payee: 'Cafe Example',
    amount: '-3.25',
    currency,
    beforeCategoryId: null,
    beforeCategoryLabel: null,
    afterCategoryId: 'food',
    afterCategoryLabel: 'Food › Cafes',
    ruleId: 'r',
    rulePayeeKey: 'cafe example',
    provenanceOnly: false,
    beforeCategoryColor: null,
    afterCategoryColor: null,
  })),
};
test('preview shows every changed native currency, authority counts and bounded-write copy', () => {
  const html = renderToStaticMarkup(<CategoryRulePreviewBody preview={preview} />);
  expect(html).toInclude('-3.25 USD');
  expect(html).toInclude('-3.25 EUR');
  expect(html).toInclude('Food › Cafes');
  expect(html).toInclude('cafe example');
  expect(html).toInclude('Only these reviewed transactions will change.');
  expect(html).toInclude('1 existing choices protected');
  expect(html).not.toInclude('Total');
});
