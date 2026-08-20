import type { FilterDefBase } from '../hooks/useDataView';

/**
 * Where a list's refinement lives — the query string (SC-71 5.1).
 *
 * `useDataView` persists sort and view mode to localStorage and keeps filters
 * and grouping in React state, so narrowing `/holdings` to `Type:
 * Cryptocurrency` survived exactly as long as the component did: a reload put
 * all 68 rows back, Back left the page rather than undoing the filter, and the
 * view was neither shareable nor restorable after an iOS tab eviction. The peek
 * has been a place since V3-11 and the three non-record sheets have been places
 * since SC-67; a *filtered list* is a place too, and this is the arithmetic
 * that makes it one.
 *
 * **A filter's key is its parameter name.** That is not a convenience — it is
 * already the contract. `HOLDING_FILTER_PARAMS` are v2's query-parameter names,
 * kept identical so the version switch carries a narrowed list across, and the
 * holdings config declares its filters under those same keys. Inventing a
 * second spelling here would mean `/holdings?account=<id>` — the link an
 * account's peek emits, and the one `resolveActiveTabPath` reads to keep the
 * Accounts tab lit — and the account filter the reader picks in Refine writing
 * two different parameters for one piece of state.
 *
 * **Search stays out.** Every keystroke would be a URL write behind a 300ms
 * debounce, and a half-typed query is not a place anyone wants to return to.
 * Filters and grouping are chosen once from a sheet; the search box is
 * transient by construction.
 */

/** Which axis the list is grouped by. `group` is taken — it is a *filter* key
 *  on the holdings surface — so the group-by axis spells itself out. */
export const GROUP_BY_PARAM = 'groupBy';

export interface DataViewUrlState {
  filters: Record<string, string>;
  groupBy: string;
}

export const EMPTY_URL_STATE: DataViewUrlState = { filters: {}, groupBy: '' };

/**
 * A page that mounts more than one list namespaces its parameters; a page with
 * one list does not.
 *
 * `/tokens` renders `tokens:custom` above `tokens:hidden`, and both declare a
 * `type` filter — unprefixed they would be one parameter driving two lists. The
 * `:` in a `pageKey` is already how a surface says "I am one of several here",
 * so it is what decides, rather than a second flag a call site could forget to
 * set. Single-view surfaces keep the bare key, which is what keeps
 * `?account=<id>` meaning exactly what it has always meant.
 */
export function viewParamName(pageKey: string, key: string): string {
  const separator = pageKey.indexOf(':');
  return separator === -1 ? key : `${pageKey.slice(separator + 1)}.${key}`;
}

export function readDataViewUrl(
  search: string,
  pageKey: string,
  filterDefs: FilterDefBase[] | undefined
): DataViewUrlState {
  const params = new URLSearchParams(search);
  const filters: Record<string, string> = {};
  for (const def of filterDefs ?? []) {
    const value = params.get(viewParamName(pageKey, def.key));
    if (value) filters[def.key] = value;
  }
  return { filters, groupBy: params.get(viewParamName(pageKey, GROUP_BY_PARAM)) ?? '' };
}

/**
 * The search string with this list's refinement written onto it, and
 * everything else left alone — `?sheet=refine:holdings` is on the URL while the
 * sheet that sets these is open, and a second list on the same page owns its
 * own namespaced keys.
 *
 * An empty value deletes its parameter rather than writing a blank one: a URL
 * carrying `?account=` says the reader narrowed by account and chose nothing,
 * which is not a state this list has.
 */
export function writeDataViewUrl(
  search: string,
  pageKey: string,
  filterDefs: FilterDefBase[] | undefined,
  next: DataViewUrlState
): string {
  const params = new URLSearchParams(search);
  const set = (key: string, value: string) => {
    const name = viewParamName(pageKey, key);
    if (value) params.set(name, value);
    else params.delete(name);
  };

  for (const def of filterDefs ?? []) set(def.key, next.filters[def.key] ?? '');
  set(GROUP_BY_PARAM, next.groupBy);

  const query = params.toString();
  return query.length > 0 ? `?${query}` : '';
}

/** Whether two refinement states describe the same list. */
export function sameUrlState(a: DataViewUrlState, b: DataViewUrlState): boolean {
  if (a.groupBy !== b.groupBy) return false;
  const keys = new Set([...Object.keys(a.filters), ...Object.keys(b.filters)]);
  for (const key of keys) {
    if ((a.filters[key] ?? '') !== (b.filters[key] ?? '')) return false;
  }
  return true;
}
