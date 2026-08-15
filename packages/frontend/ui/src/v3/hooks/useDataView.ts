import { useCallback, useEffect, useMemo, useState } from 'react';
import { useBulkSelection } from './useBulkSelection';

/**
 * The list-state machine behind every Scani list surface — search, filter,
 * sort, group-by and bulk-select.
 *
 * It was written for `apps/frontend/app`'s v2 `DataView` and is imported
 * unchanged by v3's `V3DataView`, which replaced the presentation and kept the
 * model. V3-28 promoted it here because `apps/frontend/cloud` needs the same
 * surface for its key list, and a second copy of a stateful hook is a second
 * place for the persistence format to drift.
 *
 * The `scani-v2-` prefix is deliberately kept: it is a live localStorage key on
 * every account that has ever sorted a v2 list, and renaming it would silently
 * reset their sort. v3 namespaces itself *inside* `pageKey` (`v3:holdings`)
 * rather than by changing the prefix, for the same reason.
 */
const dataViewStateKey = (page: string) => `scani-v2-dv-${page}`;

export interface FilterDef {
  key: string;
  label: string;
  options: { value: string; label: string }[];
  /** Custom filter function. If not provided, no automatic filtering is done for this key. */
  // biome-ignore lint/suspicious/noExplicitAny: Generic filter function
  fn?: (item: any, value: string) => boolean;
}

export interface SortDef {
  key: string;
  label: string;
}

export interface GroupByDef {
  key: string;
  label: string;
  /** Function to extract group label from an item */
  // biome-ignore lint/suspicious/noExplicitAny: Generic group function
  groupFn?: (item: any) => string;
  /** Alias for groupFn */
  // biome-ignore lint/suspicious/noExplicitAny: Generic group function
  fn?: (item: any) => string;
}

export interface DataViewConfig<T> {
  pageKey: string;
  data: T[];
  searchFn?: (item: T, query: string) => boolean;
  filterDefs?: FilterDef[];
  sortDefs?: SortDef[];
  sortFn?: (a: T, b: T, field: string, direction: 'asc' | 'desc') => number;
  groupByDefs?: GroupByDef[];
  defaultSort?: { field: string; direction: 'asc' | 'desc' };
  defaultView?: 'table' | 'cards';
  defaultFilters?: Record<string, string>;
}

export interface DataViewReturn<T> {
  searchTerm: string;
  setSearchTerm: (v: string) => void;
  filters: Record<string, string>;
  setFilter: (key: string, value: string) => void;
  clearFilters: () => void;
  hasActiveFilters: boolean;
  sortField: string;
  sortDirection: 'asc' | 'desc';
  setSort: (field: string) => void;
  groupBy: string;
  setGroupBy: (v: string) => void;
  viewMode: 'table' | 'cards';
  setViewMode: (v: 'table' | 'cards') => void;
  filteredData: T[];
  groupedData: Map<string, T[]> | null;
  totalCount: number;
  filteredCount: number;
  selectedIds: Set<string>;
  toggleSelect: (id: string) => void;
  selectAll: () => void;
  clearSelection: () => void;
  isAllSelected: boolean;
}

function loadPersistedState(pageKey: string) {
  try {
    const raw = localStorage.getItem(dataViewStateKey(pageKey));
    if (raw) return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // ignore
  }
  return null;
}

function persistState(pageKey: string, state: Record<string, unknown>) {
  try {
    localStorage.setItem(dataViewStateKey(pageKey), JSON.stringify(state));
  } catch {
    // ignore
  }
}

export function useDataView<T>(
  config: DataViewConfig<T>,
  getId: (item: T) => string
): DataViewReturn<T> {
  const {
    pageKey,
    data,
    searchFn,
    filterDefs,
    sortDefs,
    sortFn,
    groupByDefs,
    defaultSort,
    defaultView,
  } = config;

  const persisted = useMemo(() => loadPersistedState(pageKey), [pageKey]);

  const [searchTerm, setSearchTerm] = useState('');
  const [filters, setFilters] = useState<Record<string, string>>(config.defaultFilters ?? {});
  const [sortField, setSortField] = useState<string>(
    (persisted?.sortField as string) ?? defaultSort?.field ?? sortDefs?.[0]?.key ?? ''
  );
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>(
    (persisted?.sortDirection as 'asc' | 'desc') ?? defaultSort?.direction ?? 'asc'
  );
  const [groupBy, setGroupBy] = useState('');
  const [viewMode, setViewModeState] = useState<'table' | 'cards'>(
    (persisted?.viewMode as 'table' | 'cards') ?? defaultView ?? 'table'
  );

  // Persist viewMode and sort state
  useEffect(() => {
    persistState(pageKey, { viewMode, sortField, sortDirection });
  }, [pageKey, viewMode, sortField, sortDirection]);

  const setFilter = useCallback((key: string, value: string) => {
    setFilters((prev) => {
      if (!value) {
        const next = { ...prev };
        delete next[key];
        return next;
      }
      return { ...prev, [key]: value };
    });
  }, []);

  const clearFilters = useCallback(() => {
    setFilters({});
    setSearchTerm('');
  }, []);

  const hasActiveFilters = useMemo(
    () => Object.keys(filters).length > 0 || searchTerm.length > 0,
    [filters, searchTerm]
  );

  const setSort = useCallback(
    (field: string) => {
      if (field === sortField) {
        setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'));
      } else {
        setSortField(field);
        setSortDirection('asc');
      }
    },
    [sortField]
  );

  const setViewMode = useCallback((v: 'table' | 'cards') => {
    setViewModeState(v);
  }, []);

  // Filter + search + sort
  const filteredData = useMemo(() => {
    let result = [...data];

    // Search
    if (searchTerm && searchFn) {
      const query = searchTerm.toLowerCase();
      result = result.filter((item) => searchFn(item, query));
    }

    // Filters (use custom fn if available, else simple key match)
    if (filterDefs) {
      for (const [key, value] of Object.entries(filters)) {
        if (!value) continue;
        const def = filterDefs.find((d) => d.key === key);
        result = result.filter((item) => {
          if (def?.fn) return def.fn(item, value);
          const itemValue = (item as Record<string, unknown>)[key];
          return String(itemValue) === value;
        });
      }
    }

    // Sort
    if (sortField && sortFn) {
      result.sort((a, b) => sortFn(a, b, sortField, sortDirection));
    }

    return result;
  }, [data, searchTerm, searchFn, filters, filterDefs, sortField, sortDirection, sortFn]);

  // Group
  const groupedData = useMemo(() => {
    if (!groupBy || !groupByDefs) return null;
    const def = groupByDefs.find((d) => d.key === groupBy);
    if (!def) return null;

    const map = new Map<string, T[]>();
    for (const item of filteredData) {
      const groupFn = def.fn || def.groupFn;
      if (!groupFn) continue;
      const key = groupFn(item);
      const group = map.get(key);
      if (group) {
        group.push(item);
      } else {
        map.set(key, [item]);
      }
    }
    return map;
  }, [filteredData, groupBy, groupByDefs]);

  // Selection
  const ids = useMemo(() => filteredData.map(getId), [filteredData, getId]);
  const { selectedIds, toggleSelect, selectAll, clearSelection, isAllSelected } =
    useBulkSelection(ids);

  return {
    searchTerm,
    setSearchTerm,
    filters,
    setFilter,
    clearFilters,
    hasActiveFilters,
    sortField,
    sortDirection,
    setSort,
    groupBy,
    setGroupBy,
    viewMode,
    setViewMode,
    filteredData,
    groupedData,
    totalCount: data.length,
    filteredCount: filteredData.length,
    selectedIds,
    toggleSelect,
    selectAll,
    clearSelection,
    isAllSelected,
  };
}
