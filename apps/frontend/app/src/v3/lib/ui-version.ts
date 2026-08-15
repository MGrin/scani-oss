/**
 * Which UI generation a URL belongs to, how to cross between them, and
 * where the user's choice is remembered.
 *
 * **v3 owns the root and v2 lives under `/v2` (V3-19).** It used to be the
 * other way round. The flip is deliberate rather than cosmetic: the default
 * interface should have the canonical URLs, so an old bookmark to
 * `/payments/recurring/<id>` opens that payment in the interface the reader
 * now gets everywhere else, and only a reader who has *chosen* the classic UI
 * is sent to a prefixed address.
 *
 * v2's paths are v3's under a `/v2` prefix by construction, so crossing to v2
 * is a pure prefix add and needs no route table. Crossing *into* v3 does need
 * one: v2 has screens v3 never built, and landing on a route that does not
 * exist is a blank screen rather than a switch.
 *
 * v2 is not going away. The switch is permanent chrome in both directions, not
 * a migration affordance with a deletion date.
 */

export type UiVersion = 'v2' | 'v3';

/** v3's home. v3 is mounted at the root, so this is the whole of its base. */
export const V3_BASE = '/';

/**
 * v2's namespace.
 *
 * v2's own route table is relative (`V2App` mounts under a splat) and every
 * link in v2 is built from `V2_ROUTES`, so giving v2 a prefix is one edit in
 * that table rather than a sweep through the tree.
 */
export const V2_BASE = '/v2';

/** What a reader with no stored preference gets. This is the flip. */
export const DEFAULT_UI_VERSION: UiVersion = 'v3';

const STORAGE_KEY = 'scani.ui-version';

/** v3 surfaces that exist today. Each later v3 ticket appends the routes
 * it ships; `:param` matches a single non-empty segment.
 *
 * This is the *crossable* set, not the routed set: `/kitchen-sink` and
 * `/integrations/:providerKey` are real v3 routes that are deliberately absent
 * because v2 has no URL to cross from. So it answers "where may the switch
 * land", never "does v3 own this path" — `V3App`'s own catch-all answers that
 * one, and it answers it by construction. */
const V3_ROUTE_PATTERNS: readonly string[] = [
  V3_BASE,
  // Holdings (V3-12). v2's holding detail is a page at `/holdings/<id>` and
  // v3's is a peek sheet at the same path, so the switch carries a record
  // across rather than dropping the reader back on the list.
  '/holdings',
  '/holdings/:id',
  // Capture (V3-14). The chooser itself has no URL — it is a sheet over
  // whatever screen you were on — so only the form it leads to is listed.
  '/manual-entry',
  // Money (V3-13). The peeks are listed too: a v2 user reading
  // `/v2/payments/recurring/<id>` and pressing the switch should land on that
  // record's sheet, not on the v3 home screen.
  '/payments',
  '/payments/recurring',
  '/payments/recurring/:id',
  '/payments/recurring/:id/edit',
  '/vendors',
  '/vendors/:id',
  // The More destinations (V3-15). A v2 reader on `/v2/accounts/<id>` or
  // `/v2/jobs/<id>` who presses the switch should land on that record — as a
  // peek for the first, as a page for the second — rather than on the v3 home
  // screen.
  //
  // Groups and tokens list only their index: v2 has no `/groups/<id>` or
  // `/tokens/<id>` to cross *from*, and a pattern for a path that cannot be
  // reached is a claim this table should not make.
  '/review',
  '/jobs',
  '/jobs/:id',
  '/accounts',
  '/accounts/:id',
  '/institutions',
  '/institutions/:id',
  '/vaults',
  '/vaults/:id',
  '/groups',
  '/tokens',
  // The remaining capture destinations (V3-44). `/integrations/:providerKey`
  // is not here — v2 has no per-provider URL, so there is nothing to cross
  // from, and a pattern for a path that cannot be reached is a claim this table
  // should not make.
  '/import',
  '/wallet-import',
  '/integrations',
  '/documents/upload',
  // Files and Settings (V3-43). `documents/:id` is what finally claims the
  // whole segment below Files, and `documents/upload` above is why that is
  // safe: `segmentsMatch` has no static-over-dynamic precedence, so an upload
  // screen v3 had *not* built would resolve against the id pattern and be read
  // as a document called "upload". V3-44 built it, so it does not.
  '/documents',
  '/documents/:id',
  '/settings',
];

function normalize(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith('/')) {
    return pathname.replace(/\/+$/, '') || '/';
  }
  return pathname;
}

function segmentsMatch(pattern: string, pathname: string): boolean {
  const patternSegments = pattern.split('/');
  const pathSegments = pathname.split('/');
  if (patternSegments.length !== pathSegments.length) return false;
  return patternSegments.every((segment, i) => {
    const actual = pathSegments[i];
    if (actual === undefined) return false;
    return segment.startsWith(':') ? actual.length > 0 : segment === actual;
  });
}

function isBuiltV3Path(pathname: string): boolean {
  return V3_ROUTE_PATTERNS.some((pattern) => segmentsMatch(pattern, pathname));
}

/**
 * Which generation a URL addresses.
 *
 * Whole-segment matching, so `/v2-archive` is a v3 path — the same rule
 * `resolveActiveNavPath` uses on the v2 side.
 */
export function uiVersionForPath(pathname: string): UiVersion {
  const path = normalize(pathname);
  return path === V2_BASE || path.startsWith(`${V2_BASE}/`) ? 'v2' : 'v3';
}

/**
 * Which generation should actually render for a URL, given what the reader has
 * chosen before.
 *
 * The rule in one line: **an explicit `/v2` URL always wins, and everywhere
 * else the stored preference decides — defaulting to v3.** That is what lets a
 * reader who picked the classic UI keep it across this deploy without being
 * moved (their old root bookmarks and the PWA's `/` both resolve to v2 for
 * them), while a reader who never chose anything gets v3 at `/`.
 *
 * The converse — a v3 reader who follows a `/v2/...` link — is honoured rather
 * than bounced, because after the flip a `/v2` address can only come from the
 * switch or from a deliberate link. Before the flip the two trees shared one
 * namespace and a v2 URL was usually reached by habit, which is why the old
 * gate redirected it and needed an exemption list to keep v3's own links to
 * borrowed v2 screens working. One namespace each retires both.
 */
export function activeUiVersion(
  pathname: string,
  stored: UiVersion | null = readStoredUiVersion()
): UiVersion {
  return uiVersionForPath(pathname) === 'v2' ? 'v2' : (stored ?? DEFAULT_UI_VERSION);
}

/**
 * Where the switch should land when crossing to `target`. Best-effort:
 * a v2 path with no counterpart in v3 falls back to the v3 home rather than to
 * a route that renders nothing.
 *
 * **`search` crosses with the path, and dropping it was a real bug** (V3-46).
 * Both generations spell their query keys the same way — that is the reason
 * `HOLDING_FILTER_PARAMS` and `ACCOUNT_FILTER_PARAMS` exist — so a query that
 * means "these holdings, for this account" on one side means it on the other.
 * Losing it silently is what made every completion surface in the app land the
 * user on an unfiltered list: v3 renders v2's job-result renderers unchanged,
 * and each one links to a path carrying its own context —
 * `/holdings?account=<id>` after a file import, `/holdings?institution=<id>`
 * after an exchange import, and `/payments/recurring/new?fromExtraction=<id>`
 * after an invoice.
 *
 * It rides only on a *real* counterpart. The fallback to `V3_BASE` deliberately
 * drops it: a query describes the screen it was written for, and `/?account=x`
 * is a claim about the home screen that nothing there can honour.
 */
export function counterpartPath(pathname: string, target: UiVersion, search = ''): string {
  const query = search && !search.startsWith('?') ? `?${search}` : search;
  const path = normalize(pathname);
  if (uiVersionForPath(path) === target) return `${path}${query}`;
  if (target === 'v2') return `${V2_BASE}${path === V3_BASE ? '' : path}${query}`;
  const candidate = path.slice(V2_BASE.length) || V3_BASE;
  return isBuiltV3Path(candidate) ? `${candidate}${query}` : V3_BASE;
}

/** Where v3 was mounted while it was being built, and the only thing this
 *  prefix is still used for. */
export const LEGACY_V3_BASE = '/v3';

/**
 * Where a root URL should actually be served from, or `null` to render v3 where
 * the reader already is. `UiVersionGate` is this function plus a `<Navigate>`.
 *
 * Pure so the flip's whole promise is assertable: a reader with no preference
 * gets v3, a reader who chose the classic UI is carried to the same screen
 * under `/v2` — record, query and all — and an explicit `/v2` URL is left alone
 * whatever they chose. Redirecting a `/v2` path back would be the one way to
 * make the classic UI unreachable for the readers who asked for it.
 */
export function gateRedirect(
  pathname: string,
  search = '',
  stored: UiVersion | null = readStoredUiVersion()
): string | null {
  if (uiVersionForPath(pathname) === 'v2') return null;
  if (activeUiVersion(pathname, stored) === 'v3') return null;
  return counterpartPath(pathname, 'v2', search);
}

/**
 * `/v3/holdings` → `/holdings`.
 *
 * v3 spent the whole rebuild mounted at `/v3`, so the readers most likely to
 * have bookmarked it are the ones who were testing it. Dropping the prefix on
 * arrival costs one route and keeps every one of those links alive; without it
 * they would fall to v3's own catch-all and be handed to `/v2/v3/...`, which is
 * nothing at all. It lands on the root, where the gate applies as it would to
 * any other root URL — so a stored preference is still honoured on the way
 * through.
 */
export function legacyV3Redirect(pathname: string, search = ''): string {
  return `${pathname.slice(LEGACY_V3_BASE.length) || V3_BASE}${search}`;
}

/**
 * Hangs the v3 token block off the document root, or takes it back off.
 *
 * `v3-tokens.css` scopes every declaration to `[data-ui="v3"]`, and that
 * attribute used to sit only on the v3 shell's own wrapper. Now that v3 is the
 * default it sits on `<html>` for the whole time a v3 route is rendering, which
 * is what the file's dark block has always been written for — `.dark[data-ui='v3']`
 * exists beside `.dark [data-ui='v3']` precisely so the attribute may be on the
 * root element. On the root element `[data-ui='v3']` *is* `:root`: same
 * specificity, same element, so the token layer applies to the document, its
 * background, its scrollbars and anything portalled to `<body>`.
 *
 * Doing it with the attribute rather than by importing the `:root` variant of
 * the token file is what keeps v2 byte-identical. `:root` is unconditional, and
 * v2 shares those 25 custom-property names, so a `:root` block would repaint
 * every v2 screen — and v2's Radix overlays portal to `document.body`, outside
 * any wrapper we could put a counter-scope on, so there is no element to hang
 * v2's own values from. The attribute is conditional, which is exactly the
 * difference the classic UI needs.
 */
export function applyDocumentUiVersion(version: UiVersion, root: HTMLElement): void {
  if (version === 'v3') root.setAttribute('data-ui', 'v3');
  else root.removeAttribute('data-ui');
}

type UiVersionStorage = Pick<Storage, 'getItem' | 'setItem'>;

function browserStorage(): UiVersionStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    // Safari with site data blocked throws on the property access itself,
    // before any read happens.
    return null;
  }
}

export function readStoredUiVersion(storage = browserStorage()): UiVersion | null {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    return raw === 'v2' || raw === 'v3' ? raw : null;
  } catch {
    return null;
  }
}

export function storeUiVersion(version: UiVersion, storage = browserStorage()): void {
  try {
    storage?.setItem(STORAGE_KEY, version);
  } catch {
    // Quota or private-mode failure. The switch still navigates; the
    // choice just does not survive a reload.
  }
}
