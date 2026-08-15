import { useEffect } from 'react';
import { isTextEntry, resolveFieldScrollDelta } from '@/lib/viewport';

/** iOS animates the keyboard in over roughly a third of a second and fires a
 *  `visualViewport` resize when it lands. This covers the case where no
 *  resize ever arrives — a hardware keyboard is attached, or the field was
 *  already inside the visible band and nothing moved. */
const KEYBOARD_SETTLE_MS = 320;

/**
 * Scrolls whatever the user is typing into back into the part of the page the
 * keyboard leaves visible.
 *
 * iOS does this itself, but only against the layout viewport and only for the
 * document's own scroller. A field near the bottom of a sheet's scroll
 * container is "in view" by that measure while sitting squarely behind the
 * keyboard — which is where most v3 forms now live (the capture sheet, the
 * payment form, the refine sheet), and what the user hit.
 *
 * So the correction walks the field's real scroll ancestors: the sheet's own
 * scroller absorbs what it can, whatever is left goes to the next scroller
 * out, and the document gets the remainder. That is what makes a field inside
 * a drawer end up visible *within the drawer* and above the keyboard, rather
 * than one or the other.
 *
 * `scrollIntoView` is not enough for the same reason: it knows about the
 * layout viewport and nothing about where the keyboard actually is.
 */
export function useFocusedFieldVisibility(): void {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

    let field: HTMLElement | null = null;
    let settleTimer = 0;
    let raf = 0;

    const align = () => {
      raf = 0;
      const target = field;
      // Focus can leave between the schedule and the frame — realigning a
      // field the user has already left would scroll the page under them.
      if (!target?.isConnected || document.activeElement !== target) return;
      const delta = resolveFieldScrollDelta(target.getBoundingClientRect(), {
        visualHeight: vv.height,
        visualOffsetTop: vv.offsetTop,
      });
      if (delta === 0) return;
      scrollAncestorsBy(target, delta);
    };

    const schedule = () => {
      if (raf !== 0) return;
      raf = window.requestAnimationFrame(align);
    };

    const handleFocusIn = (event: FocusEvent) => {
      if (!isTextEntry(event.target as Element | null)) {
        field = null;
        return;
      }
      field = event.target as HTMLElement;
      window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(schedule, KEYBOARD_SETTLE_MS);
    };

    const handleFocusOut = () => {
      field = null;
      window.clearTimeout(settleTimer);
    };

    // Every viewport change while a field is focused is a chance to be wrong
    // again: switching from the letters keyboard to the emoji one changes its
    // height, and so does rotating.
    const handleViewportResize = () => {
      if (field) schedule();
    };

    // A page backgrounded with the keyboard up comes back with its scrollers
    // where they were *before* the field was revealed — measured on the
    // simulator, the focused field moved from 325..405 to 501..581, i.e. from
    // inside the visible band to behind the keyboard — and it comes back
    // without a single viewport event to notice it by (SC-53). So the
    // lifecycle has to say so, exactly as it does for `useViewportEffect`.
    const handleReturn = () => {
      if (document.hidden || !field) return;
      schedule();
      // And again once the keyboard has finished coming back with the app:
      // the frame above runs while the scrollers are still being restored.
      window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(schedule, KEYBOARD_SETTLE_MS);
    };

    window.addEventListener('focusin', handleFocusIn);
    window.addEventListener('focusout', handleFocusOut);
    vv.addEventListener('resize', handleViewportResize);
    window.addEventListener('pageshow', handleReturn);
    document.addEventListener('visibilitychange', handleReturn);

    return () => {
      window.clearTimeout(settleTimer);
      if (raf !== 0) window.cancelAnimationFrame(raf);
      window.removeEventListener('focusin', handleFocusIn);
      window.removeEventListener('focusout', handleFocusOut);
      vv.removeEventListener('resize', handleViewportResize);
      window.removeEventListener('pageshow', handleReturn);
      document.removeEventListener('visibilitychange', handleReturn);
    };
  }, []);
}

/**
 * Moves `delta` px of scroll into the element's scrollable ancestors,
 * nearest first, and returns whatever none of them could absorb.
 *
 * Assigning `scrollTop` past an end clamps rather than throws, so measuring
 * what actually moved is what lets the remainder fall through to the next
 * scroller out instead of being applied twice.
 */
function scrollAncestorsBy(element: HTMLElement, delta: number): number {
  let remaining = delta;
  let node = element.parentElement;

  while (node && Math.abs(remaining) >= 1) {
    const overflowY = window.getComputedStyle(node).overflowY;
    if (
      (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') &&
      node.scrollHeight > node.clientHeight
    ) {
      const before = node.scrollTop;
      node.scrollTop = before + remaining;
      remaining -= node.scrollTop - before;
    }
    node = node.parentElement;
  }

  if (Math.abs(remaining) >= 1) window.scrollBy(0, remaining);
  return remaining;
}
