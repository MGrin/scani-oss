/**
 * The URL arithmetic for the overlays that are *not* a record — the capture
 * sheet, the More drawer and a list's Refine sheet.
 *
 * `lib/peek.ts` made a record's sheet a place, because a record is one:
 * `/v3/holdings/abc` names a thing and the back gesture closes it. These three
 * are not records and cannot take a path segment — they open over *any* screen,
 * and swapping the pathname would unmount the page the sheet is drawn on top of
 * and lose its scroll position. So they take a search parameter instead, over
 * the pathname the user is already on.
 *
 * What matters is that the mechanism is peek's, not that the URL shape is: a
 * push on open, `history.back()` on close when we were the ones who pushed, and
 * a replace when we were not. Without it the browser's Back — the primary
 * gesture on iOS — moves the page *underneath* an open sheet, which is D-6.
 *
 * Pure functions here rather than logic inside the hook, for peek's reason: the
 * cases that bite (a deep link nobody pushed, a sheet closing over another
 * surface's history entry, a pathname that already carries a query) are
 * testable without a router or a DOM.
 */

export const SHEET_PARAM = 'sheet';

/** The capture sheet — "Add data". One per app, so a bare key. */
export const CAPTURE_SHEET = 'add';

/** The tab bar's More drawer. */
export const MORE_SHEET = 'more';

/**
 * A list surface's Refine sheet, keyed by the surface.
 *
 * Keyed rather than bare because a page may mount more than one `V3DataView` —
 * `/v3/tokens` renders the custom-token list above the hidden-holdings list —
 * and a shared key would open both sheets at once, stacked.
 */
export function refineSheet(pageKey: string): string {
  return `refine:${pageKey}`;
}

/** A list surface's Export sheet (SC-89), keyed by the surface for
 *  `refineSheet`'s reason. A URL rather than component state so the back
 *  gesture closes it — the same reason everything else here is one. */
export function exportSheet(pageKey: string): string {
  return `export:${pageKey}`;
}

/**
 * Marks a sheet URL as one *we* pushed, so closing pops it rather than pushing
 * a second entry. Keyed by the sheet, for `PEEK_STATE_KEY`'s reason: history
 * state survives a client-side navigation between surfaces, and a flag left by
 * the More drawer must not convince a Refine sheet that its own entry is
 * poppable.
 */
export const SHEET_STATE_KEY = 'v3SheetFrom';

/** Which sheet a URL has open, or null. */
export function parseSheet(search: string): string | null {
  return new URLSearchParams(search).get(SHEET_PARAM) || null;
}

function serialize(params: URLSearchParams): string {
  const query = params.toString();
  return query.length > 0 ? `?${query}` : '';
}

/**
 * The search string with `sheet` set. Everything else on the URL is kept —
 * holdings narrowed to one account stay narrowed while the sheet is open, and
 * the tab bar keeps reading that filter (V3-40).
 */
export function sheetOpenSearch(search: string, sheet: string): string {
  const params = new URLSearchParams(search);
  params.set(SHEET_PARAM, sheet);
  return serialize(params);
}

/** The same search string with no sheet on it. */
export function sheetClosedSearch(search: string): string {
  const params = new URLSearchParams(search);
  params.delete(SHEET_PARAM);
  return serialize(params);
}

export function sheetOpenState(sheet: string): Record<string, string> {
  return { [SHEET_STATE_KEY]: sheet };
}

export type SheetCloseAction = { type: 'back' } | { type: 'replace'; to: string };

/**
 * How to leave a sheet.
 *
 * Pop it if we pushed it, so closing and the back gesture are the same act and
 * opening Refine five times does not bury the list five entries deep. If we did
 * not — the sheet was deep-linked, or the entry was restored on reload — there
 * is nothing of ours to pop and `navigate(-1)` would leave the app, so the URL
 * is replaced with the same screen minus the sheet.
 */
export function resolveSheetClose(
  sheet: string,
  pathname: string,
  search: string,
  state: unknown
): SheetCloseAction {
  const pushedFrom =
    typeof state === 'object' && state !== null
      ? (state as Record<string, unknown>)[SHEET_STATE_KEY]
      : undefined;
  if (pushedFrom === sheet) return { type: 'back' };
  return { type: 'replace', to: `${pathname}${sheetClosedSearch(search)}` };
}
