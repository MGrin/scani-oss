import '../../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import {
  type CategoryNodeView,
  CategoryPicker,
  formatCategoryPath,
} from '../../../../src/v3/components/categories/CategoryPicker';

const FOOD: CategoryNodeView = {
  id: 'food',
  name: 'Food',
  color: null,
  children: [{ id: 'groceries', name: 'Groceries', color: '#22aa55', children: [] }],
};

function render(nodes: CategoryNodeView[], extra: { allowClear?: boolean; query?: string } = {}) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <CategoryPicker
        name="test-picker"
        nodes={nodes}
        value={null}
        onChange={() => {}}
        onCreate={() => {}}
        onSuggest={() => {}}
        initialQuery={extra.query}
        allowClear={extra.allowClear}
      />
    </MemoryRouter>
  );
}

describe('CategoryPicker (SC-1652)', () => {
  test('lists a child indented under its parent, both choosable', () => {
    const html = render([FOOD]);
    expect(html).toInclude('Food');
    expect(html).toInclude('Groceries');
    expect(html.indexOf('Food')).toBeLessThan(html.indexOf('Groceries'));
    expect(html).toInclude('data-depth="1"');
    expect(html.match(/type="radio"/g)).toHaveLength(2);
    expect(html).toInclude('Manage categories');
  });

  test('with no categories, offers the starter set and creating one', () => {
    const html = render([]);
    expect(html).toInclude('No categories yet.');
    expect(html).toInclude('Add suggested categories');
    expect(html).toInclude('Create category');
    expect(html).not.toInclude('type="radio"');
  });

  test('a search that names nothing offers to create it', () => {
    const html = render([FOOD], { query: 'Rent' });
    expect(html).toInclude('Create “Rent”');
    expect(render([FOOD], { query: 'groceries' })).not.toInclude('Create “groceries”');
    expect(html).not.toInclude('Groceries');
  });

  test('a search matching a child keeps its parent above it', () => {
    const html = render([FOOD], { query: 'groc' });
    expect(html).toInclude('Food');
    expect(html).toInclude('Groceries');
    expect(html.indexOf('Food')).toBeLessThan(html.indexOf('Groceries'));
  });

  test('allowClear adds a choice for no category', () => {
    expect(render([FOOD], { allowClear: true })).toInclude('No category');
  });
});

describe('formatCategoryPath', () => {
  test('names a child with its parent, and a parent alone', () => {
    expect(formatCategoryPath([FOOD], 'groceries')).toBe('Food › Groceries');
    expect(formatCategoryPath([FOOD], 'food')).toBe('Food');
    expect(formatCategoryPath([FOOD], 'missing')).toBeNull();
  });
});
