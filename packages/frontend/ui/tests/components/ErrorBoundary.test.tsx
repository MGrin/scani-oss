import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { CrashFallback } from '../../src/components/ErrorBoundary';
import { UserFacingError } from '../../src/lib/user-facing-error';

/**
 * The screen a crash puts in front of a reader (SC-311).
 *
 * The fallback is rendered directly rather than by making React throw:
 * `renderToStaticMarkup` has no DOM and error boundaries do not catch during
 * server rendering, which is the same reason `ChunkErrorBoundary.test.tsx`
 * exports its fallback. What matters here is what the markup says.
 *
 * This is the surface with no way out: the installed PWA has no URL bar, so a
 * reader who lands here reads whatever it says and presses the one button
 * (SC-62, SC-73). It must never be a sentence about React hook contracts.
 */

function markupFor(error: Error | null): string {
  return renderToStaticMarkup(<CrashFallback error={error} onGoHome={() => {}} />);
}

describe('CrashFallback', () => {
  it('shows a message somebody wrote for a reader', () => {
    expect(markupFor(new UserFacingError('Nothing to export'))).toContain('Nothing to export');
  });

  it('does not leak a hook-contract assertion', () => {
    const markup = markupFor(new Error('useTheme must be used within a ThemeProvider'));
    expect(markup).not.toContain('ThemeProvider');
    expect(markup).toContain('An unexpected error occurred');
  });

  it('does not leak an argument assertion', () => {
    const markup = markupFor(new Error('snapPoints must contain at least one value in (0, 1]'));
    expect(markup).not.toContain('snapPoints');
    expect(markup).toContain('An unexpected error occurred');
  });

  it('says the data is untouched, which is the thing a finance app must answer', () => {
    expect(markupFor(new Error('boom'))).toContain('Your data is untouched');
  });

  it('offers a way out even when there is no error object at all', () => {
    const markup = markupFor(null);
    expect(markup).toContain('An unexpected error occurred');
    expect(markup).toContain('Go to Dashboard');
  });

  it('takes its copy from the kit bundle rather than hard-coded English', () => {
    // A raw key on screen is the failure mode SC-250 and SC-257 were both
    // about, and it is silent — i18next resolves a missing key to itself.
    expect(markupFor(new Error('boom'))).not.toContain('ui.errors.crash');
  });
});
