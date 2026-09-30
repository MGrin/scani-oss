import {
  parseSheet,
  resolveSheetClose,
  sheetOpenSearch,
  sheetOpenState,
} from '@scani/ui/v3/lib/sheet';
import { useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { type PaymentSheetTarget, parsePaymentSheet } from '../lib/routes';

/**
 * The bill form's sheet, bound to the URL (SC-1414). `useSheetRoute` matches
 * one fixed key; an edit carries the bill's id in its key, so this reads any
 * `payment:*` value and reuses the same open and close arithmetic.
 */
export function usePaymentSheet() {
  const location = useLocation();
  const navigate = useNavigate();
  const { pathname, search, state } = location;
  const sheet = parseSheet(search);
  const target: PaymentSheetTarget | null = parsePaymentSheet(sheet);

  const close = useCallback(() => {
    if (!sheet || !target) return;
    const action = resolveSheetClose(sheet, pathname, search, state);
    if (action.type === 'back') navigate(-1);
    else navigate(action.to, { replace: true });
  }, [sheet, target, navigate, pathname, search, state]);

  /** A `<Link>`'s `to` and `state` that open `value` over the current screen,
   *  so closing the form returns to it — a bill's peek, a filtered list. */
  const linkTo = useCallback(
    (value: string) => ({
      to: { pathname, search: sheetOpenSearch(search, value) },
      state: sheetOpenState(value),
    }),
    [pathname, search]
  );

  return { key: target ? sheet : null, target, close, linkTo };
}
