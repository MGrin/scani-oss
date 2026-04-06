import { Plus, Search, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { FilterDef, GroupByDef, SortDef } from '../../hooks/useDataView';
import { FilterPill } from './FilterPill';
import { ViewToggle } from './ViewToggle';

interface DataViewToolbarProps {
  searchTerm: string;
  onSearchChange: (value: string) => void;
  filters: Record<string, string>;
  filterDefs?: FilterDef[];
  onSetFilter: (key: string, value: string) => void;
  onClearFilters: () => void;
  hasActiveFilters: boolean;
  sortField: string;
  sortDirection: 'asc' | 'desc';
  sortDefs?: SortDef[];
  onSetSort: (field: string) => void;
  groupBy: string;
  groupByDefs?: GroupByDef[];
  onSetGroupBy: (value: string) => void;
  viewMode: 'table' | 'cards';
  onSetViewMode: (mode: 'table' | 'cards') => void;
  totalCount: number;
  filteredCount: number;
}

export function DataViewToolbar({
  searchTerm,
  onSearchChange,
  filters,
  filterDefs,
  onSetFilter,
  onClearFilters,
  hasActiveFilters,
  sortField,
  sortDefs,
  onSetSort,
  groupBy,
  groupByDefs,
  onSetGroupBy,
  viewMode,
  onSetViewMode,
  totalCount,
  filteredCount,
}: DataViewToolbarProps) {
  const [localSearch, setLocalSearch] = useState(searchTerm);

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => {
      onSearchChange(localSearch);
    }, 300);
    return () => clearTimeout(timer);
  }, [localSearch, onSearchChange]);

  // Sync external changes
  useEffect(() => {
    setLocalSearch(searchTerm);
  }, [searchTerm]);

  const activeFilterEntries = Object.entries(filters).filter(([_, v]) => v);
  const availableFilterDefs = filterDefs?.filter((def) => !filters[def.key]) ?? [];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {/* Search */}
        <div className="relative min-w-[200px] flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search..."
            value={localSearch}
            onChange={(e) => setLocalSearch(e.target.value)}
            className="pl-9"
          />
        </div>

        {/* Add filter */}
        {availableFilterDefs.length > 0 && (
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm">
                <Plus className="mr-1 h-4 w-4" />
                Filter
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-56 p-2">
              {availableFilterDefs.map((def) => (
                <div key={def.key} className="mb-2 last:mb-0">
                  <p className="mb-1 px-1 text-xs font-medium text-muted-foreground">{def.label}</p>
                  {def.options.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      className="w-full rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent"
                      onClick={() => onSetFilter(def.key, opt.value)}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              ))}
            </PopoverContent>
          </Popover>
        )}

        {/* Sort */}
        {sortDefs && sortDefs.length > 0 && (
          <Select value={sortField} onValueChange={onSetSort}>
            <SelectTrigger className="w-[160px]">
              <SelectValue placeholder="Sort by..." />
            </SelectTrigger>
            <SelectContent>
              {sortDefs.map((def) => (
                <SelectItem key={def.key} value={def.key}>
                  {def.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {/* Group by */}
        {groupByDefs && groupByDefs.length > 0 && (
          <Select
            value={groupBy || '_none'}
            onValueChange={(v) => onSetGroupBy(v === '_none' ? '' : v)}
          >
            <SelectTrigger className="w-[160px]">
              <SelectValue placeholder="Group by..." />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="_none">No grouping</SelectItem>
              {groupByDefs.map((def) => (
                <SelectItem key={def.key} value={def.key}>
                  {def.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {/* View toggle */}
        <ViewToggle viewMode={viewMode} onChange={onSetViewMode} />
      </div>

      {/* Active filters + count */}
      {(activeFilterEntries.length > 0 || hasActiveFilters) && (
        <div className="flex flex-wrap items-center gap-2">
          {activeFilterEntries.map(([key, value]) => {
            const def = filterDefs?.find((d) => d.key === key);
            const optLabel = def?.options.find((o) => o.value === value)?.label ?? value;
            return (
              <FilterPill
                key={key}
                label={def?.label ?? key}
                value={optLabel}
                onRemove={() => onSetFilter(key, '')}
              />
            );
          })}
          {hasActiveFilters && (
            <Button variant="ghost" size="sm" onClick={onClearFilters} className="h-7 px-2 text-xs">
              <XCircle className="mr-1 h-3 w-3" />
              Clear all
            </Button>
          )}
          <span className="ml-auto text-xs text-muted-foreground">
            {filteredCount} of {totalCount} items
          </span>
        </div>
      )}
    </div>
  );
}
