import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  type DataViewUrlState,
  readDataViewUrl,
  sameUrlState,
  writeDataViewUrl,
} from '../lib/data-view-url';
import type { DataViewReturn, FilterDef } from './useDataView';

/**
 * Binds a list's filters and grouping to the URL — `usePeekRoute` for the state
 * that is not a record. All the arithmetic is in `lib/data-view-url.ts`; this is
 * the router calls and the one-directional sync that cannot be pure.
 *
 * **The URL is the source of truth and `useDataView` is the derivation**, in
 * that order and never the reverse. A two-way sync between a hook's state and
 * the query string is the version of this that looks obvious and then fights
 * itself: each side notices the other changed and writes back. So the setters
 * are wrapped instead — a control calls `setFilter`, that writes the URL, and
 * the effect below is the only thing that ever touches `useDataView`. Back and
 * forward then work for free, because they are just another URL change.
 *
 * `replace`, not push. Refine applies live (see `RefineSheet`), so pushing
 * would bury the list one entry deeper per option tried, and the reader who
 * narrowed four times would need five Backs to leave. The sheet itself is the
 * pushed entry — that is SC-67's job, and it is what makes Back close the
 * sheet and *then* return to the unfiltered list.
 *
 * `useDataView` is left untouched: it still owns search, sort, view mode and
 * bulk selection, and it is v2's file.
 */
export interface DataViewUrlBinding {
  setFilter: (key: string, value: string) => void;
  setGroupBy: (value: string) => void;
  /** Drops every filter *and* the search term, which is what the button that
   *  calls it says it does. Search is not on the URL, so it is cleared through
   *  the hook directly. */
  clearFilters: () => void;
}

export function useDataViewUrlState<T>(
  pageKey: string,
  filterDefs: FilterDef[] | undefined,
  dv: DataViewReturn<T>
): DataViewUrlBinding {
  const location = useLocation();
  const navigate = useNavigate();
  const { pathname, search } = location;

  const urlState = useMemo(
    () => readDataViewUrl(search, pageKey, filterDefs),
    [search, pageKey, filterDefs]
  );

  const { setFilter, setGroupBy, setSearchTerm, filters, groupBy } = dv;
  // Read through a ref so the sync effect depends on the URL alone. Depending
  // on the hook's own state would make every application of a filter a reason
  // to re-run the thing that applies filters.
  const applied = useRef({ filters, groupBy });
  applied.current = { filters, groupBy };

  useEffect(() => {
    const current: DataViewUrlState = {
      filters: applied.current.filters,
      groupBy: applied.current.groupBy,
    };
    if (sameUrlState(current, urlState)) return;
    for (const def of filterDefs ?? []) {
      const want = urlState.filters[def.key] ?? '';
      if ((current.filters[def.key] ?? '') !== want) setFilter(def.key, want);
    }
    if (current.groupBy !== urlState.groupBy) setGroupBy(urlState.groupBy);
  }, [urlState, filterDefs, setFilter, setGroupBy]);

  const push = useCallback(
    (next: DataViewUrlState) => {
      navigate(
        { pathname, search: writeDataViewUrl(search, pageKey, filterDefs, next) },
        { replace: true }
      );
    },
    [navigate, pathname, search, pageKey, filterDefs]
  );

  return {
    setFilter: useCallback(
      (key: string, value: string) => {
        push({ ...urlState, filters: { ...urlState.filters, [key]: value } });
      },
      [push, urlState]
    ),
    setGroupBy: useCallback(
      (value: string) => {
        push({ ...urlState, groupBy: value });
      },
      [push, urlState]
    ),
    clearFilters: useCallback(() => {
      setSearchTerm('');
      push({ filters: {}, groupBy: urlState.groupBy });
    }, [push, setSearchTerm, urlState.groupBy]),
  };
}
