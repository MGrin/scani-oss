import { createContext, useContext } from 'react';

/**
 * The one way to raise the capture sheet.
 *
 * The sheet is shell state rather than a route (see `CaptureSheet`), which
 * would otherwise make it reachable only from the two navigation surfaces that
 * sit beside it. It is not: the highest-value place to offer capture is an
 * empty screen, and every empty screen in v3 is a page inside the outlet.
 *
 * So the opener is published rather than the state. Nothing outside the shell
 * can close the sheet or read whether it is open, which keeps "who owns this
 * overlay" a question with one answer.
 */

const CaptureSheetContext = createContext<(() => void) | null>(null);

export const CaptureSheetProvider = CaptureSheetContext.Provider;

/**
 * Returns a no-op outside the provider. A button that silently does nothing is
 * a poor outcome, but it is a far better one than a page that throws because it
 * was rendered in a test without the shell around it.
 */
export function useOpenCapture(): () => void {
  return useContext(CaptureSheetContext) ?? (() => {});
}
