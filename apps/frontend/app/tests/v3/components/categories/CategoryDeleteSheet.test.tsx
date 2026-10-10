import '../../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  CategoryDeleteBody,
  replacementOptions,
} from '../../../../src/v3/components/categories/CategoryDeleteSheet';

const TREE = [
  {
    id: 'food',
    name: 'Food',
    color: null,
    transactionCount: 4,
    children: [
      { id: 'groceries', name: 'Groceries', color: null, transactionCount: 2, children: [] },
    ],
  },
  { id: 'travel', name: 'Travel', color: null, transactionCount: 0, children: [] },
];

function render(id: string) {
  return renderToStaticMarkup(
    <CategoryDeleteBody
      nodes={TREE}
      categoryId={id}
      replacementId={null}
      onReplacement={() => {}}
    />
  );
}

describe('CategoryDeleteSheet (SC-1652)', () => {
  test('a parent with children says its subcategories move to the top level', () => {
    const html = render('food');
    expect(html).toInclude('Its subcategories move to the top level.');
    expect(html).toInclude('4 transactions');
  });

  test('a category with no children says nothing about subcategories', () => {
    expect(render('groceries')).not.toInclude('subcategories');
  });

  test('the transactions can go anywhere but the category being deleted', () => {
    const ids = replacementOptions(TREE, 'food').map((option) => option.id);
    expect(ids).not.toContain('food');
    expect(ids).toEqual(['groceries', 'travel']);
    expect(replacementOptions(TREE, 'groceries').map((option) => option.label)).toEqual([
      'Food',
      'Travel',
    ]);
  });

  test('offers Uncategorized as a destination', () => {
    expect(render('travel')).toInclude('Uncategorized');
  });
});
