import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { UserFacingError } from '../../src/lib/user-facing-error';
import { showError, useToast } from '../../src/ui/use-toast';

/**
 * `showError` is the DEFAULT error surface, not one of several (SC-311).
 *
 * Roughly a hundred and thirty call sites reach it, so whatever it does with an
 * unknown throw is what v3 does with an unknown throw. Two failures were live
 * on `main` at 12ac04fd, pointing in opposite directions:
 *
 * 1. Any `Error` had its `message` rendered — including assertions nobody
 *    wrote for a reader.
 * 2. Any plain **string** was silently replaced by "Unknown error", because the
 *    selector asked `error instanceof Error` and a string is not one. So
 *    `showError(t('v3.capture.token.defillamaUnsupported'))` — a translated
 *    sentence explaining exactly what the reader must do — rendered as
 *    "Unknown error". Eight call sites did this.
 *
 * The toast is read through `useToast`, the same hook `Toaster` uses, rather
 * than out of module state — `memoryState` is private, and the point is what
 * reaches a renderer. `<Toaster/>` itself cannot be used: Radix mounts each
 * toast through `createPortal` into its viewport, and portals produce nothing
 * under `renderToStaticMarkup`. `TOAST_LIMIT` is 1, so this is the last call.
 */

function LastToast() {
  const { toasts } = useToast();
  const toast = toasts[0];
  return <p>{`${String(toast?.title ?? '')}|${String(toast?.description ?? '')}`}</p>;
}

function lastToastMarkup(): string {
  return renderToStaticMarkup(<LastToast />);
}

describe('showError', () => {
  it('shows a message somebody wrote for a reader', () => {
    showError(new UserFacingError('Nothing to export'));
    expect(lastToastMarkup()).toContain('Nothing to export');
  });

  it('shows a plain string, because the caller had the copy in hand', () => {
    // The regression that made this test exist: this rendered "Unknown error".
    showError('DeFiLlama results need a contract address, so they cannot be added from here.');
    expect(lastToastMarkup()).toContain('DeFiLlama results need a contract address');
  });

  it('does not leak a hook-contract assertion', () => {
    showError(new Error('useTheme must be used within a ThemeProvider'));
    const markup = lastToastMarkup();
    expect(markup).not.toContain('ThemeProvider');
    expect(markup).toContain('Unknown error');
  });

  it('keeps the caller context beside the generic sentence', () => {
    // `{{context}}: {{message}}` — the context is what the reader was doing,
    // and it stays useful even when the cause has to be generic.
    showError(new Error('x.map is not a function'), 'Creating payment');
    const markup = lastToastMarkup();
    expect(markup).toContain('Creating payment: Unknown error');
    expect(markup).not.toContain('x.map');
  });
});
