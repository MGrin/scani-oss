import { resolveShellHeight } from '@/lib/viewport';
import { useViewportEffect } from './useViewportEffect';

/**
 * Sizes the app shell to the part of the screen the keyboard leaves visible,
 * and takes back the scroll offset iOS applies to compensate for its not
 * being sized that way.
 *
 * V3-35 hid the tab bar while the keyboard was up and V3-45 put the field
 * being typed into back in view. Both were necessary and neither addressed
 * what the rest of the shell does meanwhile: it stays `100dvh`, so its lower
 * third is behind the keyboard, so iOS scrolls the whole document up to reach
 * a field down there — and a page carrying that offset paints its
 * `position: fixed` layer from the top of the *screen* instead of the top of
 * the web view. The status bar then sits on the form. Measured on an
 * installed iPhone 17e PWA: `scrollY` = `visualViewport.offsetTop` = 331 with
 * the keyboard raised, and `env(safe-area-inset-top)` still reporting 0, so
 * nothing in CSS reserves the strip the clock is drawn in.
 *
 * Sizing the shell to `visualViewport.height` is what makes the offset
 * unnecessary: the header stays put, the shell's own scroller ends where the
 * keyboard begins, and `useFocusedFieldVisibility` reveals a field by
 * scrolling *that* rather than the page. Resetting `scrollY` is therefore not
 * a second fix fighting the first — it is the half that removes the symptom
 * once the first has removed the need. Doing either alone is worse than
 * doing neither: the reset without the resize hides the field behind the
 * keyboard, and the resize without the reset leaves the offset in place.
 *
 * Only v3 mounts this, and deliberately so. The reset is safe exactly where
 * the shell is sized to the band; v2's shell is not, and taking its offset
 * away would put the field it was lifting back under the keyboard.
 *
 * Deliberately *not* floating the nav above the keyboard: V3-35 tried that
 * and it "appeared to jump higher than it should" through iOS's dismiss
 * animation. The nav still slides off and comes back; only the box it lives
 * in changes.
 */
export function useVisualViewportShell(ref: React.RefObject<HTMLElement | null>): void {
  useViewportEffect(() => {
    const shell = ref.current;
    const vv = window.visualViewport;
    if (!shell || !vv) return;

    const height = resolveShellHeight({
      layoutHeight: document.documentElement.clientHeight,
      visualHeight: vv.height,
    });

    if (height === null) {
      shell.style.height = '';
      return;
    }

    shell.style.height = `${height}px`;
    // Guarded because iOS fires a `scroll` on the visual viewport for this,
    // which re-enters here: without the check the two would trade frames for
    // as long as the keyboard is up.
    if (window.scrollY !== 0) window.scrollTo(0, 0);
  });
}
