/**
 * View preferences — the *shape* a reader chose for a screen, never the data on
 * it.
 *
 * `useDataView` already persists sort, filter and group per list, under a
 * `v3:`-namespaced page key so v3 can never write into v2's record. The
 * controls that sit outside a list had nowhere equivalent to go and reset on
 * every load: the home screen's allocation cut, its metric and its period. This
 * is that missing place, and it keeps the same namespacing discipline — a v3
 * key can never be a v2 key.
 *
 * Two properties are what make this a preference store rather than a second
 * store of data:
 *
 * - **The read is total.** Absent, unreadable, or naming an option that no
 *   longer exists all resolve to the caller's fallback. Retiring a dimension
 *   can therefore never strand someone on a chart with nothing behind it; the
 *   default silently takes over.
 * - **The write never fails loudly.** Safari with site data blocked throws on
 *   the `localStorage` property access itself, before any read happens, and a
 *   full quota throws on write. Either way the control still works — the choice
 *   just does not survive the reload.
 *
 * Both halves are `typeof window`-guarded because these components are rendered
 * through `renderToStaticMarkup` in tests, where there is no storage at all.
 */

const PREFIX = 'scani.v3.view.';

/**
 * Every persisted view preference, named in one place so a key is never a
 * string literal at a call site and two screens can never collide by accident.
 */
export const VIEW_PREFERENCE_KEYS = {
  homeAllocationDimension: 'home.allocation-dimension',
  homeMetric: 'home.metric',
  homePeriod: 'home.period',
} as const;

export type ViewPreferenceKey = (typeof VIEW_PREFERENCE_KEYS)[keyof typeof VIEW_PREFERENCE_KEYS];

type ViewPreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>;

function browserStorage(): ViewPreferenceStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function viewPreferenceStorageKey(key: ViewPreferenceKey): string {
  return `${PREFIX}${key}`;
}

export function readViewPreference<T extends string>(
  key: ViewPreferenceKey,
  fallback: T,
  allowed: readonly T[],
  storage = browserStorage()
): T {
  try {
    const raw = storage?.getItem(viewPreferenceStorageKey(key));
    return allowed.find((option) => option === raw) ?? fallback;
  } catch {
    return fallback;
  }
}

export function writeViewPreference(
  key: ViewPreferenceKey,
  value: string,
  storage = browserStorage()
): void {
  try {
    storage?.setItem(viewPreferenceStorageKey(key), value);
  } catch {
    // Quota or private-mode failure. Losing a preference is not worth an error.
  }
}
