import { isKeyboardObscuring } from '@/lib/viewport';
import { useViewportEffect } from './useViewportEffect';

/**
 * Hide a bottom-pinned bar whenever the visual viewport shrinks meaningfully
 * below the layout viewport — i.e. the iOS software keyboard is up (or
 * mid-animation). Trying to float the nav above the keyboard makes it appear
 * to "jump higher than it should" during the multi-hundred-ms dismiss
 * animation, which the user explicitly disliked. So instead of tracking the
 * keyboard, we just slide off until the keyboard is fully down.
 *
 * One copy, above the v2/v3 split, because the user reports the dead band in
 * both shells. v3's copy was corrected in V3-35 while v2's — the app he
 * actually uses — was left on the original `window.innerHeight` expression
 * under the "v2 is untouched" rule, so the bug he reported stayed live in the
 * UI he reported it from (SC-53). There is nothing v3-specific in here to
 * justify two of them.
 *
 * The measurement is against the *layout* viewport, not `window.innerHeight`.
 * `innerHeight - (offsetTop + height)` is correct in a browser tab, where
 * `innerHeight` holds at the full 714 while the keyboard is up, and wrong in
 * an installed PWA, where iOS shrinks it in step with the visual viewport
 * (812 → 744): the two terms cancel and the gap came out at −68 with the
 * keyboard plainly up, leaving the bar stranded mid-screen.
 * `document.documentElement.clientHeight` did not move in any sample.
 */
export function useVisualViewportPin(ref: React.RefObject<HTMLElement | null>): void {
  useViewportEffect(() => {
    const nav = ref.current;
    const vv = window.visualViewport;
    if (!nav || !vv) return;

    if (
      isKeyboardObscuring({
        layoutHeight: document.documentElement.clientHeight,
        visualHeight: vv.height,
      })
    ) {
      nav.style.transform = 'translate3d(0, 100%, 0)';
      nav.style.pointerEvents = 'none';
      nav.setAttribute('aria-hidden', 'true');
    } else {
      nav.style.transform = '';
      nav.style.pointerEvents = '';
      nav.removeAttribute('aria-hidden');
    }
  });
}
