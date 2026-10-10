import '../../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { CategoryRow, categoryTotal } from '../../../../src/v3/components/categories/CategoryRow';

const FOOD = {
  id: 'food',
  name: 'Food',
  color: null,
  transactionCount: 1,
  children: [
    { id: 'groceries', name: 'Groceries', color: null, transactionCount: 3, children: [] },
  ],
};

describe('CategoryRow on a phone (SC-1652)', () => {
  test('a parent counts its subcategories too', () => {
    expect(categoryTotal(FOOD)).toBe(4);
    expect(categoryTotal(FOOD.children[0]!)).toBe(3);
  });

  test('the whole row is one button that opens the category, with no inline Edit or Delete', () => {
    const html = renderToStaticMarkup(<CategoryRow node={FOOD} depth={0} onOpen={() => {}} />);
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toInclude('Food');
    expect(html).not.toInclude('>Edit<');
    expect(html).not.toInclude('>Delete<');
  });

  test('the count sits on its own line under the name and never wraps', () => {
    const html = renderToStaticMarkup(<CategoryRow node={FOOD} depth={0} onOpen={() => {}} />);
    expect(html).toMatch(/flex-col[^"]*"/);
    expect(html).toMatch(/<span[^>]*whitespace-nowrap[^>]*>4 transactions<\/span>/);
  });

  test('a subcategory is indented and its parent is not', () => {
    const parent = renderToStaticMarkup(<CategoryRow node={FOOD} depth={0} onOpen={() => {}} />);
    const child = renderToStaticMarkup(
      <CategoryRow node={FOOD.children[0]!} depth={1} onOpen={() => {}} />
    );
    expect(child).toInclude('ps-6');
    expect(parent).not.toInclude('ps-6');
  });
});
