import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ApyPreview } from '@/v3/components/holdings/ApyConfigSheet';

/**
 * The sheet is a Radix dialog and Radix renders NOTHING under
 * `renderToStaticMarkup`, so an assertion against the whole form would pass
 * over an empty string. Its sentence is `apyPreviewSentence`'s and is asserted
 * in `lib/apy.test.ts`; what is left here is the one thing only the DOM can
 * carry — that the sentence is announced when it changes.
 */
describe('the payout summary', () => {
  test('is a live region, because it rewrites itself under the reader', () => {
    const markup = renderToStaticMarkup(
      <ApyPreview text="Monthly on day 15. At today’s balance the next payout is about 37.50 EUR." />
    );
    expect(markup).toContain('role="status"');
    expect(markup).toContain('37.50 EUR');
  });
});
