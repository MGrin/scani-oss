import { useCallback, useEffect, useRef } from 'react';

/**
 * Puts focus back on the control that opened an overlay, once it closes.
 *
 * Radix does this for free — for a dialog opened by its own `<Trigger>`. Every
 * overlay in v3 is opened by a **URL** instead (`lib/peek.ts`, `lib/sheet.ts`),
 * so there is no trigger in Radix's tree to return to and its `FocusScope`
 * restores to whatever `document.activeElement` was when the content mounted:
 * `<body>`, because the navigation commits first. Measured on `/holdings`
 * (SC-71 5.3) — open Refine, press Escape, press Tab, and the next stop is the
 * top of the sidebar rather than the Refine button the reader just left.
 *
 * The trigger is captured **when `open()` runs**, not in an effect, and that is
 * the whole trick: inside the click handler the button is still focused, while
 * by the time any effect of ours runs the sheet has already pulled focus into
 * itself. Focus trapping *while* open is Radix's and is correct — verified
 * across 30 tab presses; this is only the way out.
 *
 * The restore is deferred one frame because Radix's own close-autofocus runs on
 * unmount and would otherwise land last.
 */
export function useReturnFocus(isOpen: boolean): () => void {
  const trigger = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(isOpen);

  useEffect(() => {
    if (wasOpen.current && !isOpen) {
      const target = trigger.current;
      trigger.current = null;
      if (target) {
        requestAnimationFrame(() => {
          // A row that opened a peek can be gone by the time the peek closes —
          // a refetch reordered the list, a delete removed it. Focusing a
          // detached node silently moves focus to `<body>`, which is the state
          // this hook exists to avoid, so it is better to change nothing.
          if (target.isConnected) target.focus();
        });
      }
    }
    wasOpen.current = isOpen;
  }, [isOpen]);

  return useCallback(() => {
    const active = document.activeElement;
    // `<body>` means nothing was focused — Safari does not focus a button on
    // click — and there is nothing to come back to.
    trigger.current = active instanceof HTMLElement && active !== document.body ? active : null;
  }, []);
}
