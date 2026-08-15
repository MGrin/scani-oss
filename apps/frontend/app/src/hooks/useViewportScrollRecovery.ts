import { hasStrandedDocumentScroll, isKeyboardObscuring } from '@/lib/viewport';
import { useViewportEffect } from './useViewportEffect';

/**
 * Puts the document back at the top once the iOS keyboard is gone.
 *
 * The reported bug is a band of dead space below the tab bar that survives
 * the keyboard and only a restart clears. It is not a stuck style: focusing a
 * field below the fold makes WebKit scroll the *document* — `window.scrollY`
 * 0 → 68 measured on iOS 26.5 in an installed PWA — even though the shell is
 * `height: 100dvh; overflow: hidden` and has no scroll range. A
 * `position: fixed; bottom: 0` bar is placed against the layout viewport, so
 * while that offset is held the bar draws 68px up from the physical bottom
 * and the strip beneath it is empty. Restoring the offset is therefore the
 * exact inverse of the cause, not a cosmetic patch over it.
 *
 * `hasStrandedDocumentScroll` refuses to touch a document that genuinely
 * scrolls, so a page that owns its scroll position is never yanked to the
 * top; only a document with no scroll range — where a non-zero offset can
 * only be this artifact — is reset.
 *
 * Mounted once above the v2/v3 split, because the user hits this in both and
 * the behaviour belongs to the document rather than to either shell.
 *
 * `useViewportEffect` is what makes it survive a trip to the home screen: an
 * app that is backgrounded holding this offset and then reopened gets no
 * viewport event at all (SC-53), so before that hook this ran on every
 * dismissal *except* the one the user described — the one where the band was
 * still there after coming back.
 */
export function useViewportScrollRecovery(): void {
  useViewportEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    const layoutHeight = document.documentElement.clientHeight;
    // While the keyboard is up the offset is doing its job — holding the
    // focused field above it. Only once the viewport is back at rest is a
    // leftover offset unambiguously stranded.
    if (isKeyboardObscuring({ layoutHeight, visualHeight: vv.height })) return;
    const stranded = hasStrandedDocumentScroll({
      layoutHeight,
      visualOffsetTop: vv.offsetTop,
      scrollY: window.scrollY,
      documentScrollHeight: document.documentElement.scrollHeight,
    });
    if (!stranded) return;
    window.scrollTo(0, 0);
  });
}
