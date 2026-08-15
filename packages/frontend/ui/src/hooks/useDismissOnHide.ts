import { useEffect, useRef } from 'react';

/**
 * Close a confirmation when the app goes away, so it cannot be answered in a
 * context the reader has forgotten (SC-124).
 *
 * A primed confirm used to survive an arbitrary background cycle: open Delete,
 * get distracted, return twenty minutes later, tap to get your bearings — and
 * the affirmative is still armed under your finger, in a dialog you no longer
 * remember opening. On an installed webclip that is the ordinary way the app is
 * used, not an edge case.
 *
 * This defeats a control v3 built on purpose. SC-63/SC-73 put distance between
 * the trigger and the affirmative so a stray tap could not reach it, and
 * `ConfirmAction` enforces it by geometry. Distance protects against a
 * *misaimed* tap; it does nothing against a deliberate tap in a context that no
 * longer exists, which is exactly what a background cycle manufactures.
 *
 * **Why dismissing, rather than the two alternatives.**
 *
 * - *Re-arm on return after a timeout* keeps the surface but makes its meaning
 *   depend on elapsed time, which is invisible: the same screen is live or dead
 *   depending on a clock the reader cannot see, and a reader who taps a dead
 *   button learns nothing about why it did nothing.
 * - *Require a fresh gesture before the affirmative goes live* is the same
 *   problem wearing a scrim — it puts a disabled destructive button on screen,
 *   which SC-113 is a whole ticket about not doing.
 * - *Dismissing* costs the reader one tap to re-open the record, and a confirm
 *   holds no work: it is a question, not a draft. The only state that can go
 *   with it is a `chooser` selection (vendor merge), which is one tap to redo
 *   and which the parent resets on cancel anyway.
 *
 * **Both events, because neither covers the other.** `visibilitychange` is what
 * fires when an app is backgrounded or the screen locks — the reported case.
 * `pagehide` is what fires when the page is frozen into the back/forward cache
 * or navigated away from, which on iOS is routinely the only one of the two
 * that arrives. `blur` is deliberately NOT listened for: it fires when focus
 * moves to another window while the page is still fully on screen, and closing
 * a confirm the reader is looking at is a bug, not a safeguard.
 *
 * @param active whether the confirmation is currently open and answerable.
 * @param dismiss closes it. Called at most once per hide; may be a fresh
 *   closure on every render — it is read through a ref, so the listeners are
 *   installed once per `active` transition rather than once per render.
 */
export function useDismissOnHide(active: boolean, dismiss: () => void): void {
  const dismissRef = useRef(dismiss);
  dismissRef.current = dismiss;

  useEffect(() => {
    if (!active) return;
    return subscribeToHide(() => dismissRef.current());
  }, [active]);
}

/** The narrowest slice of `document` this needs, so the wiring is assertable
 *  without a DOM — this suite renders to static markup and has none. */
interface HideSource {
  visibilityState: string;
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
}
interface UnloadSource {
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
}

/**
 * Calls `onHide` the next time the page is backgrounded or frozen; returns the
 * unsubscribe. Split out of the hook above so the rule it encodes — *both*
 * events, and `visibilitychange` only when the state is actually `hidden` —
 * can be tested rather than described.
 */
export function subscribeToHide(
  onHide: () => void,
  doc: HideSource = document,
  win: UnloadSource = window
): () => void {
  // A `visibilitychange` also fires on the way *back*, with the state
  // `visible`. Dismissing on that one would close the confirm the reader has
  // just returned to and is looking at.
  const onVisibilityChange = () => {
    if (doc.visibilityState === 'hidden') onHide();
  };
  doc.addEventListener('visibilitychange', onVisibilityChange);
  win.addEventListener('pagehide', onHide);
  return () => {
    doc.removeEventListener('visibilitychange', onVisibilityChange);
    win.removeEventListener('pagehide', onHide);
  };
}
