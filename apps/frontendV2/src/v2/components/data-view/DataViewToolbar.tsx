import { ArrowDown, ArrowUp, Layers, Plus, Search, XCircle } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { FilterDef } from '../../hooks/useDataView';

function FilterPopover({
  filterDefs,
  onSetFilter,
}: {
  filterDefs: FilterDef[];
  onSetFilter: (key: string, value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState(filterDefs[0]?.key || '');
  const [filterSearch, setFilterSearch] = useState('');

  const activeDef = filterDefs.find((d) => d.key === activeTab);

  const filteredOptions = useMemo(() => {
    if (!activeDef) return [];
    if (!filterSearch) return activeDef.options;
    const q = filterSearch.toLowerCase();
    return activeDef.options.filter((o) => o.label.toLowerCase().includes(q));
  }, [activeDef, filterSearch]);

  // Reset search when tab changes
  useEffect(() => {
    setFilterSearch('');
  }, [activeTab]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="shrink-0">
          <Plus className="mr-1 h-3.5 w-3.5" />
          Filter
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-0">
        {/* Tabs */}
        {filterDefs.length > 1 && (
          <div className="flex border-b border-border overflow-x-auto">
            {filterDefs.map((def) => (
              <button
                key={def.key}
                type="button"
                onClick={() => setActiveTab(def.key)}
                className={`px-3 py-2 text-xs whitespace-nowrap transition-colors border-b-2 ${
                  activeTab === def.key
                    ? 'border-primary text-foreground font-medium'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                }`}
              >
                {def.label}
              </button>
            ))}
          </div>
        )}

        {/* Search */}
        <div className="p-2 border-b border-border">
          <Input
            value={filterSearch}
            onChange={(e) => setFilterSearch(e.target.value)}
            placeholder={`Search ${activeDef?.label || ''}...`}
            className="h-8 text-xs"
          />
        </div>

        {/* Options */}
        <div className="max-h-[250px] overflow-y-auto p-1">
          {filteredOptions.length === 0 ? (
            <p className="px-3 py-4 text-xs text-muted-foreground text-center">No matches</p>
          ) : (
            filteredOptions.map((opt) => (
              <button
                key={opt.value}
                type="button"
                className="w-full rounded-sm px-3 py-2 text-left text-sm hover:bg-accent flex items-center gap-2"
                onClick={() => {
                  onSetFilter(activeDef!.key, opt.value);
                  setOpen(false);
                }}
              >
                <span className="truncate">{opt.label}</span>
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { GroupByDef, SortDef } from '../../hooks/useDataView';
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
  sortDirection,
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

  useEffect(() => {
    const timer = setTimeout(() => {
      onSearchChange(localSearch);
    }, 300);
    return () => clearTimeout(timer);
  }, [localSearch, onSearchChange]);

  useEffect(() => {
    setLocalSearch(searchTerm);
  }, [searchTerm]);

  const activeFilterEntries = Object.entries(filters).filter(([_, v]) => v);
  const availableFilterDefs = filterDefs?.filter((def) => !filters[def.key]) ?? [];

  return (
    <div className="space-y-2">
      {/* Row 1: Search + Filter */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search..."
            value={localSearch}
            onChange={(e) => setLocalSearch(e.target.value)}
            className="pl-9"
          />
        </div>

        {availableFilterDefs.length > 0 && (
          <FilterPopover filterDefs={availableFilterDefs} onSetFilter={onSetFilter} />
        )}
      </div>

      {/* Row 2: Sort + Group + View toggle */}
      <div className="flex items-center gap-2">
        {/* Sort: field selector + direction toggle */}
        {sortDefs && sortDefs.length > 0 && (
          <div className="flex items-center rounded-md border border-border overflow-hidden">
            <Select value={sortField} onValueChange={onSetSort}>
              <SelectTrigger className="h-8 border-0 rounded-none text-xs min-w-[90px] sm:min-w-[120px] focus:ring-0">
                <span className="text-muted-foreground text-[10px] mr-1">Sort:</span>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {sortDefs.map((def) => (
                  <SelectItem key={def.key} value={def.key}>
                    {def.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <button
              type="button"
              onClick={() => onSetSort(sortField)}
              className="h-8 px-2 border-l border-border hover:bg-accent transition-colors flex items-center"
              title={
                sortDirection === 'asc'
                  ? 'Ascending — click for descending'
                  : 'Descending — click for ascending'
              }
            >
              {sortDirection === 'asc' ? (
                <ArrowUp className="h-3.5 w-3.5 text-muted-foreground" />
              ) : (
                <ArrowDown className="h-3.5 w-3.5 text-muted-foreground" />
              )}
            </button>
          </div>
        )}

        {/* Group by */}
        {groupByDefs && groupByDefs.length > 0 && (
          <Select
            value={groupBy || '_none'}
            onValueChange={(v) => onSetGroupBy(v === '_none' ? '' : v)}
          >
            <SelectTrigger className="h-8 text-xs flex-1 sm:flex-none sm:min-w-[120px] sm:w-auto">
              <Layers className="h-3 w-3 mr-1 shrink-0 text-muted-foreground" />
              <SelectValue />
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

        <div className="ml-auto">
          <ViewToggle viewMode={viewMode} onChange={onSetViewMode} />
        </div>
      </div>

      {/* Row 3: Active filters + count */}
      {(activeFilterEntries.length > 0 || hasActiveFilters) && (
        <div className="flex flex-wrap items-center gap-1.5">
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
            <Button
              variant="ghost"
              size="sm"
              onClick={onClearFilters}
              className="h-6 px-2 text-[11px] text-muted-foreground"
            >
              <XCircle className="mr-1 h-3 w-3" />
              Clear all
            </Button>
          )}
          <span className="ml-auto text-[11px] text-muted-foreground">
            {filteredCount} of {totalCount}
          </span>
        </div>
      )}
    </div>
  );
}
