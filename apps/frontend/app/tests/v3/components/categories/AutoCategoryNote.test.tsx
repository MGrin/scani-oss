import '../../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AutoCategoryNote } from '../../../../src/v3/components/categories/AutoCategoryNote';

describe('AutoCategoryNote (SC-1695)', () => {
  test('a rule says which pick it matched, with a Keep button', () => {
    const html = renderToStaticMarkup(
      <AutoCategoryNote setBy="rule" payee="Tesco" onKeep={() => {}} pending={false} />
    );
    expect(html).toInclude('Matched your earlier pick for Tesco');
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toInclude('>Keep<');
  });

  test("a person's or an import's category shows nothing", () => {
    for (const setBy of ['person', 'import', null] as const) {
      expect(
        renderToStaticMarkup(
          <AutoCategoryNote setBy={setBy} payee="Tesco" onKeep={() => {}} pending={false} />
        )
      ).toBe('');
    }
  });
});
