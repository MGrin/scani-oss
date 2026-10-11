import '../../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { CategoryFormBody } from '../../../../src/v3/components/categories/CategoryFormSheet';

const DRAFT = { name: 'Food', parentId: null, color: '#64748b', hasChildren: false };

function render(id: string | null) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <CategoryFormBody
        draft={{ id, ...DRAFT }}
        parents={[]}
        total={4}
        onChange={() => {}}
        onDelete={() => {}}
      />
    </MemoryRouter>
  );
}

describe('CategoryFormSheet (SC-1652)', () => {
  test('editing a category offers Delete inside the sheet, and a way to its transactions', () => {
    const html = render('food');
    expect(html).toMatch(/<button[^>]*>.*Delete<\/button>/s);
    expect(html).toInclude('href="/transactions?category=food"');
    expect(html).toInclude('4 transactions');
  });

  test('a new category has nothing to delete and no transactions yet', () => {
    const html = render(null);
    expect(html).not.toInclude('Delete');
    expect(html).not.toInclude('/transactions');
  });
});
