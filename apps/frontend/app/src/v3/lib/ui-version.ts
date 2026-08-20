/**
 * Where the app is mounted, and the two addresses it used to answer on.
 *
 * There is one interface now (SC-423). This file used to carry the whole
 * two-generation apparatus — which URL belonged to which tree, how to cross
 * between them, where the reader's choice was remembered, and a table of the
 * v3 screens the switch was allowed to land on. All of it existed to serve a
 * second tree, and all of it went with that tree.
 *
 * What survives is the part that outlives it: **old URLs still arrive.** v3
 * spent its whole build at `/v3`, and the classic interface spent its last
 * months at `/v2`, so those prefixes are in bookmarks, in the installed PWA's
 * start URL for anyone who chose the classic UI, and in links people sent each
 * other. Both are now stripped on arrival rather than left to fall through —
 * which they would survive, since a path v3 does not route reaches a real
 * not-found screen now, but arriving at the screen you asked for beats
 * arriving at an apology for it.
 */

/** v3's home. It is mounted at the root, so this is the whole of its base. */
export const V3_BASE = '/';

/** Where v3 was mounted while it was being built. */
export const LEGACY_V3_BASE = '/v3';

/**
 * Where the classic interface lived from V3-19 until it was deleted.
 *
 * Its route names were v3's by construction — the prefix was the only
 * difference, which is what made giving it a namespace one edit rather than a
 * sweep — so stripping the prefix lands the reader on the same screen under
 * the interface that replaced it. Where v3 never built the counterpart the
 * path falls to v3's catch-all and the reader gets the not-found screen with
 * the address they asked for quoted back, which is the honest answer and was
 * not available while this prefix was live.
 */
export const LEGACY_V2_BASE = '/v2';

/**
 * `/v3/holdings` → `/holdings`, `/v2/holdings` → `/holdings`.
 *
 * The query rides along. Both prefixes spelled their filter keys the same way
 * as the root does — that is why `HOLDING_FILTER_PARAMS` and
 * `ACCOUNT_FILTER_PARAMS` exist — so `?account=<id>` means the same thing on
 * the other side of the strip, and dropping it silently was a real bug the
 * last time this crossing was written (V3-46).
 */
export function stripLegacyBase(pathname: string, base: string, search = ''): string {
  return `${pathname.slice(base.length) || V3_BASE}${search}`;
}

/**
 * Hangs the v3 token block off the document root.
 *
 * `v3-tokens.css` scopes every declaration to `[data-ui="v3"]`, and on
 * `<html>` that selector *is* `:root` — same element, same specificity — so
 * the token layer applies to the document, its background, its scrollbars and
 * anything portalled to `<body>`. `.dark[data-ui='v3']` exists beside
 * `.dark [data-ui='v3']` in that file precisely so the attribute may sit on
 * the root element.
 *
 * It used to be conditional, because the classic interface shared all 25
 * shadcn custom-property names and a token block that could not be taken back
 * off would have repainted every one of its screens. There is nothing left to
 * repaint, so it is set once from `main.tsx` before React's first paint and
 * never removed — which is also why the component that kept it in step across
 * navigations is gone.
 */
export function applyDocumentUiVersion(root: HTMLElement): void {
  root.setAttribute('data-ui', 'v3');
}
