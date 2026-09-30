import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { GROUP_COLORS, GroupColorChoice } from '../../../src/v3/components/groups/GroupColorChoice';

const render = (value: string) =>
  renderToStaticMarkup(<GroupColorChoice value={value} onChange={() => {}} />);

const checked = (html: string) =>
  [...html.matchAll(/aria-checked="true"[^>]*background-color:\s*([^;"]+)/g)].map((m) => m[1]);

describe('GroupColorChoice marks the saved colour (SC-1419)', () => {
  test('a palette colour is the one checked swatch, and the row stays ten', () => {
    const html = render(GROUP_COLORS[5]);
    expect(checked(html)).toHaveLength(1);
    expect(html.match(/role="radio"/g)).toHaveLength(10);
  });

  test('the palette match ignores case', () => {
    expect(checked(render(GROUP_COLORS[5].toUpperCase()))).toHaveLength(1);
  });

  test('a colour outside the palette leads the row, checked, instead of showing nothing selected', () => {
    const html = render('#2563eb');
    expect(html.match(/role="radio"/g)).toHaveLength(11);
    expect(checked(html)).toHaveLength(1);
    expect(html.indexOf('aria-checked="true"')).toBeLessThan(html.indexOf('aria-checked="false"'));
  });
});
