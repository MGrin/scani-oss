import { describe, expect, test } from 'bun:test';
import type { CategorySpendingReport } from '@scani/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom';
import { CategorySpendingView } from '../../../src/v3/pages/CategorySpendingPage';

const tokenId = '11111111-1111-4111-8111-111111111111';
const data: CategorySpendingReport = {
  month: '2026-01',
  from: '2026-01-01T00:00:00.000Z',
  to: '2026-02-01T00:00:00.000Z',
  effectiveTo: '2026-02-01T00:00:00.000Z',
  generatedAt: '2026-11-25T00:00:00.000Z',
  accounts: [{ id: 'account', name: 'Everyday', isActive: false }],
  currencies: [
    {
      tokenId,
      symbol: 'EUR',
      name: 'Euro',
      total: '123456789012345678901234567890.11',
      count: 503,
      unreviewedCount: 2,
      categories: [
        {
          categoryId: null,
          name: null,
          color: null,
          total: '123456789012345678901234567890.11',
          count: 503,
        },
      ],
    },
  ],
  excludedSplitCount: 1,
  excludedUnclassifiedCount: 2,
  detail: null,
};
function render(props: Partial<Parameters<typeof CategorySpendingView>[0]> = {}) {
  return renderToStaticMarkup(
    <StaticRouter location="/transactions/spending">
      <CategorySpendingView
        input={{ month: '2026-01' }}
        loading={false}
        onChange={() => {}}
        onRetry={() => {}}
        {...props}
      />
    </StaticRouter>
  );
}
describe('category spending view', () => {
  test('loading and failures do not present a stale total or false zero', () => {
    expect(render({ loading: true, data })).not.toContain('123456789012345678901234567890.11');
    expect(render({ error: 'Failed', data })).not.toContain('123456789012345678901234567890.11');
    expect(render({ data: { ...data, currencies: [] } })).toContain('No recorded spending');
  });
  test('shows exact strings, honest population and inactive account labels without report machinery', () => {
    const html = render({ data });
    expect(html).toContain('123456789012345678901234567890.11');
    expect(html).not.toContain('123,456,789,012,345,680');
    expect(html).toContain('Uncategorized');
    expect(html).toContain('Inactive');
    expect(html.toLowerCase()).toContain('refunds');
    expect(html).toContain('UTC');
    expect(html.toLowerCase()).toContain('investment');
    expect(html).not.toContain('Export');
    expect(html).not.toContain('type="search"');
  });
  test('detail pages replace rows and retain exact source values with next/previous links', () => {
    const html = render({
      input: { month: '2026-01', detail: { tokenId, category: 'all', offset: 50 } },
      data: {
        ...data,
        detail: {
          categoryName: null,
          total: '503',
          count: 503,
          nextOffset: 100,
          rows: [
            {
              id: 'row',
              quantity: '-0.004',
              occurredAt: '2026-01-15T12:00:00.123456Z',
              description: 'Test cafe',
              counterparty: null,
              accountName: 'Everyday',
              accountInactive: true,
              holdingInactive: true,
              tokenId,
              symbol: 'EUR',
              categoryPath: 'Food › Cafes',
              categoryColor: null,
              categorySetBy: 'person',
            },
          ],
        },
      },
    });
    expect(html).toContain('-0.004');
    expect(html).toContain('2026-01-15T12:00:00.123456Z');
    expect(html).toContain('offset=100');
    expect(html).toContain('offset=0');
    expect(html).not.toContain('Load more');
    expect(html).not.toContain('Reconciled');
  });
  test('an empty later page does not fabricate a visible row range or lose the category label', () => {
    const html = render({
      input: { month: '2026-01', detail: { tokenId, category: tokenId, offset: 500 } },
      data: {
        ...data,
        detail: { categoryName: 'Food', total: '52', count: 52, nextOffset: null, rows: [] },
      },
    });
    expect(html).toContain('Food');
    expect(html).toContain('Transactions 0–0 of 52');
    expect(html).toContain('No transactions on this page');
    expect(html).toContain('First page');
  });
});
