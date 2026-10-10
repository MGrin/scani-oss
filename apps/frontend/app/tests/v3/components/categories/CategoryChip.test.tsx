import '../../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { CategoryChip } from '../../../../src/v3/components/categories/CategoryChip';

describe('CategoryChip (SC-1695)', () => {
  test('an automatic category carries a marker a screen reader names', () => {
    const html = renderToStaticMarkup(<CategoryChip name="Food" color={null} auto />);
    expect(html).toInclude('aria-label="Set automatically"');
    expect(html).toInclude('Food');
  });

  test("a person's category carries no marker", () => {
    const html = renderToStaticMarkup(<CategoryChip name="Food" color={null} />);
    expect(html).not.toInclude('Set automatically');
  });
});
