/**
 * Geometry for the two things iOS does to a page when its software keyboard
 * comes up, kept as pure functions because the repo has no DOM test
 * environment and this is the half worth asserting on.
 *
 * Everything here was measured on iOS 26.5 (iPhone 17 Pro Simulator) in an
 * installed PWA — `display-mode: standalone` — not inferred. The numbers in
 * the comments are real samples from that run.
 */

/** The visual viewport is never *exactly* the layout viewport at rest: iOS
 *  reports sub-pixel differences and a browser tab's URL bar collapses in
 *  steps, which the original `useVisualViewportPin` measured at under 30px.
 *  Its 50px threshold is kept verbatim — the fault being fixed here is which
 *  height the difference is taken from, not how much of one counts. */
const KEYBOARD_OBSCURING_MIN_PX = 50;

/** Breathing room between a focused field and the top of the keyboard. Less
 *  than this and the field is technically visible while reading as flush
 *  against the keyboard. */
const FIELD_VISIBILITY_MARGIN_PX = 16;

export interface ViewportMetrics {
  /** `document.documentElement.clientHeight` — the *layout* viewport. This is
   *  the stable number: it read 812 in every sample, keyboard up or down. */
  layoutHeight: number;
  /** `visualViewport.height` — what the user can actually see. */
  visualHeight: number;
  /** `visualViewport.offsetTop`. */
  visualOffsetTop: number;
  /** `window.scrollY`. */
  scrollY: number;
  /** `document.documentElement.scrollHeight`. */
  documentScrollHeight: number;
}

/**
 * Is the software keyboard (or its accessory bar) occupying the screen?
 *
 * Measured against the *layout* viewport rather than `window.innerHeight`,
 * which is what `useVisualViewportPin` has always used and what makes it
 * misread an installed PWA. In a browser tab `innerHeight` stays at the full
 * 714 while the keyboard is up, so `innerHeight - (offsetTop + height)`
 * yields a correct 337. In standalone iOS shrinks `innerHeight` in step with
 * the visual viewport — 812 → 744 — so the same expression collapses to −68
 * and reports the keyboard as down while it is plainly up. `clientHeight`
 * does not move, so the difference is honest in both modes.
 */
export function isKeyboardObscuring(
  metrics: Pick<ViewportMetrics, 'layoutHeight' | 'visualHeight'>,
  minPx: number = KEYBOARD_OBSCURING_MIN_PX
): boolean {
  return metrics.layoutHeight - metrics.visualHeight > minPx;
}

/**
 * Is this page carrying a document scroll offset it never asked for?
 *
 * When a field below the fold is focused, WebKit scrolls the field's own
 * scroll container *and then scrolls the document* — `window.scrollY` went
 * 0 → 68 on a root that is `height: 100dvh; overflow: hidden`, i.e. on a
 * document with no scroll range at all. A `position: fixed; bottom: 0` bar is
 * laid out against the layout viewport, so that offset draws the bar 68px
 * above the physical bottom and leaves the band below it empty. That band is
 * the reported bug.
 *
 * The scroll-range check is what makes resetting it safe: a document that
 * genuinely scrolls owns its scroll position and must never be yanked to the
 * top, so this only fires where any non-zero offset is by definition the
 * artifact. `+1` absorbs fractional layout heights.
 */
export function hasStrandedDocumentScroll(
  metrics: Pick<
    ViewportMetrics,
    'layoutHeight' | 'visualOffsetTop' | 'scrollY' | 'documentScrollHeight'
  >
): boolean {
  if (metrics.scrollY === 0 && metrics.visualOffsetTop === 0) return false;
  return metrics.documentScrollHeight <= metrics.layoutHeight + 1;
}

/**
 * How tall the app shell may be, or `null` when it should be left at the
 * `100dvh` its class gives it.
 *
 * Measured on iPhone 17e / iOS 26.5, installed to the home screen, focusing
 * the Notes field at the bottom of the payment form:
 *
 *   at rest:      clientHeight 797  visualViewport 797  offsetTop 0  scrollY 0
 *   keyboard up:  clientHeight 797  visualViewport 421  offsetTop 331  scrollY 331
 *
 * The shell is `100dvh` — 797 — in both, so with the keyboard up its lower
 * 376px are behind the keyboard and the only way to see the bottom of a form
 * is the offset iOS applies to get there. That offset is the defect: while it
 * is held, a `position: fixed` element paints from the top of the *screen*
 * rather than from the top of the web view, so the status bar lands on top of
 * whatever the form has been lifted into it — the clock inside an input.
 * `env(safe-area-inset-top)` cannot rescue that; it read 0 with the keyboard
 * up exactly as it does at rest.
 *
 * Sizing the shell to the visible band removes the reason for the offset:
 * every field is inside a scroller that fits between the header and the
 * keyboard, so the shell's own scroller can reveal one without the page
 * moving. `useVisualViewportShell` puts the offset back to zero, which is
 * only safe *because* of this sizing — the two are one fix.
 */
export function resolveShellHeight(
  metrics: Pick<ViewportMetrics, 'layoutHeight' | 'visualHeight'>,
  minPx: number = KEYBOARD_OBSCURING_MIN_PX
): number | null {
  if (!isKeyboardObscuring(metrics, minPx)) return null;
  return Math.max(0, Math.round(metrics.visualHeight));
}

export interface Rect {
  top: number;
  bottom: number;
}

/**
 * How far the page must scroll *down* (positive) or *up* (negative) to put
 * `field` inside the region the keyboard leaves visible.
 *
 * Both rectangles are in client coordinates, so the visible band is
 * `[offsetTop, offsetTop + visualHeight]` — the visual viewport expressed
 * against the layout viewport the field's `getBoundingClientRect()` already
 * uses. Returns 0 when the field already fits, and prefers revealing the
 * field's bottom edge when it is taller than the band (a textarea): the
 * caret is at the end of what is being typed.
 */
export function resolveFieldScrollDelta(
  field: Rect,
  metrics: Pick<ViewportMetrics, 'visualHeight' | 'visualOffsetTop'>,
  margin: number = FIELD_VISIBILITY_MARGIN_PX
): number {
  const bandTop = metrics.visualOffsetTop + margin;
  const bandBottom = metrics.visualOffsetTop + metrics.visualHeight - margin;
  if (field.bottom > bandBottom) return field.bottom - bandBottom;
  if (field.top < bandTop) return field.top - bandTop;
  return 0;
}

/** Controls that raise a keyboard. A checkbox is an `<input>` and does not. */
export function isTextEntry(element: Element | null): element is HTMLElement {
  if (!(element instanceof HTMLElement)) return false;
  if (element.isContentEditable) return true;
  if (element instanceof HTMLTextAreaElement) return true;
  if (!(element instanceof HTMLInputElement)) return false;
  return ![
    'button',
    'checkbox',
    'color',
    'file',
    'image',
    'radio',
    'range',
    'reset',
    'submit',
  ].includes(element.type);
}
