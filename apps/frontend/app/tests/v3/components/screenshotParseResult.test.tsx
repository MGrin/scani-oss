import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import { DiscardedReviewCard } from '@/v3/components/jobs/DiscardedReviewCard';
import { ScreenshotParseResult } from '@/v3/components/jobs/ScreenshotParseResult';
import { resolveV3ReviewRenderer } from '@/v3/lib/job-result';

/**
 * The branches of the screenshot renderer that a static render can reach — the
 * ones that do NOT mount the review card, which takes a tRPC mutation. The
 * card's own rules are asserted in `tests/v3/lib/review-holdings.test.ts`,
 * where they are pure.
 */

function render(node: ReactNode): string {
  return renderToStaticMarkup(<StaticRouter location="/jobs/job-1">{node}</StaticRouter>);
}

const FAILED = {
  accountId: 'acc-1',
  results: [{ r2Key: 'u/1/a.png', success: false, error: 'openai 400' }],
};

describe('ScreenshotParseResult', () => {
  test('v3 owns the screenshot-parse entry rather than delegating it', () => {
    expect(resolveV3ReviewRenderer('screenshot-parse').kind).toBe('screenshot-parse');
    // The delegation is still the default for everything not yet rewritten,
    // which is the property that keeps this a slice rather than a big bang.
    expect(resolveV3ReviewRenderer('wallet-import').kind).toBe('wallet-import');
  });

  test('a discarded parse says nothing was written, not that it was imported', () => {
    const html = render(
      <ScreenshotParseResult result={FAILED} jobId="job-1" reviewOutcome="discarded" />
    );
    expect(html).toContain('Discarded');
    expect(html).toContain('Nothing from this screenshot was written');
    expect(html).not.toContain('Already imported');
  });

  /**
   * The provider's own error is implementation detail. What is actionable is
   * what kind of file it was, and the advice differs — a scanned PDF and a busy
   * screenshot fail for different reasons and are fixed differently.
   */
  test('a failure explains the file kind and never the provider error', () => {
    const image = render(<ScreenshotParseResult result={FAILED} jobId="job-1" />);
    expect(image).toContain('1 file could not be read');
    expect(image).toContain('low-resolution or very busy screenshots');
    expect(image).not.toContain('openai');

    const pdf = render(
      <ScreenshotParseResult
        result={{ ...FAILED, results: [{ r2Key: 'u/1/a.pdf', success: false, error: 'x' }] }}
        jobId="job-1"
      />
    );
    expect(pdf).toContain('scanned, image-only or encrypted PDFs');
  });

  /**
   * v2's copy here sends the reader to the upload page "to pick the account and
   * confirm the extracted holdings". That page has had no review step since the
   * review moved onto the job — it starts a fresh upload — so the instruction
   * named an action that could not be taken, and the rows stayed stranded
   * either way.
   */
  test('rows with no account are told the truth, not sent to a page that cannot help', () => {
    const html = render(
      <ScreenshotParseResult
        result={{
          accountId: null,
          results: [
            {
              r2Key: 'u/1/a.png',
              success: true,
              data: { holdings: [{ symbol: 'BTC', balance: '1', tokenId: 'tok' }] },
            },
          ],
        }}
        jobId="job-1"
      />
    );
    expect(html).toContain('did not record which account');
    expect(html).toContain('Upload again');
    expect(html).toContain('href="/import"');
    expect(html).not.toContain('confirm the extracted holdings');
  });

  test('the figures come from the results even when no summary was recorded', () => {
    const html = render(
      <ScreenshotParseResult
        result={{
          accountId: null,
          results: [
            { r2Key: 'u/1/a.png', success: true, data: { holdings: [{ symbol: 'BTC' }] } },
            { r2Key: 'u/1/b.png', success: false },
          ],
        }}
        jobId="job-1"
      />
    );
    expect(html).toContain('Files read');
    expect(html).toContain('1 of 2');
    expect(html).not.toContain('0 of 2');
  });
});

describe('DiscardedReviewCard', () => {
  /**
   * The subject is a discriminant, not a noun dropped into a sentence: Russian
   * declines the noun and reorders the clause around it, so `"This {{noun}} was
   * discarded"` is a shape that cannot be translated (SC-235).
   */
  test('each subject gets a whole sentence', () => {
    expect(render(<DiscardedReviewCard subject="statement" />)).toContain(
      'Nothing from this statement was written'
    );
    expect(render(<DiscardedReviewCard subject="files" />)).toContain(
      'Nothing from these files was written'
    );
  });

  test('an unparseable stamp shows no date rather than an invalid one', () => {
    const html = render(<DiscardedReviewCard subject="screenshot" actionTakenAt="not-a-date" />);
    expect(html).not.toContain('Invalid');
    expect(html).not.toContain('NaN');
    expect(html).toContain('Discarded');
  });
});
