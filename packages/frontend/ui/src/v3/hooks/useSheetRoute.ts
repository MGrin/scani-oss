import { useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { parseSheet, resolveSheetClose, sheetOpenSearch, sheetOpenState } from '../lib/sheet';
import { useReturnFocus } from './useReturnFocus';

/**
 * Binds a non-record sheet to the URL — `usePeekRoute` for the overlays that
 * cannot own a path segment. Every decision is in `lib/sheet.ts`; this is the
 * two router calls that cannot be pure.
 *
 * `setOpen` is the shape Radix's `onOpenChange` wants, so a sheet keeps taking
 * a boolean and does not have to know it is routed.
 */
export function useSheetRoute(sheet: string) {
  const location = useLocation();
  const navigate = useNavigate();

  const isOpen = parseSheet(location.search) === sheet;
  const { pathname, search, state } = location;
  // A sheet opened by a URL has no Radix `<Trigger>`, so nothing returns focus
  // to the control that raised it — see `useReturnFocus` (SC-71 5.3).
  const captureTrigger = useReturnFocus(isOpen);

  const open = useCallback(() => {
    captureTrigger();
    navigate(
      { pathname, search: sheetOpenSearch(search, sheet) },
      { state: sheetOpenState(sheet) }
    );
  }, [captureTrigger, navigate, pathname, search, sheet]);

  const close = useCallback(() => {
    // A sheet that is already off the URL has nothing to close. Radix and vaul
    // both re-announce `onOpenChange(false)` while a dismissal animates out,
    // and a second `navigate(-1)` would pop the entry *behind* the list.
    if (!isOpen) return;
    const action = resolveSheetClose(sheet, pathname, search, state);
    if (action.type === 'back') navigate(-1);
    else navigate(action.to, { replace: true });
  }, [isOpen, navigate, pathname, search, sheet, state]);

  const setOpen = useCallback(
    (next: boolean) => {
      if (next) open();
      else close();
    },
    [open, close]
  );

  return { isOpen, open, close, setOpen };
}
