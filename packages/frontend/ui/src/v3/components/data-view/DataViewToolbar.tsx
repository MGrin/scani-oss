import { Search, Sliders, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useUiTranslation } from '../../../i18n';
import { cn } from '../../../lib/cn';
import { Badge } from '../../../ui/badge';
import { Button } from '../../../ui/button';
import { Input } from '../../../ui/input';

export interface DataViewToolbarFilter {
  key: string;
  label: string;
  value: string;
}

export interface DataViewToolbarProps {
  search: string;
  onSearchChange: (value: string) => void;
  searchPlaceholder: string;
  searchLabel: string;
  onRefine: () => void;
  activeFilters: readonly DataViewToolbarFilter[];
  onRemoveFilter: (key: string) => void;
  /** Controls after Refine, such as Select on a phone. */
  trailing?: ReactNode;
}

/**
 * The list toolbar: search, the Refine button that opens the filter sheet, and
 * one removable chip per applied filter (SC-1405).
 *
 * `V3DataView` renders it, and so does any list that groups its rows in a way
 * `useDataView` cannot seed, such as the date-grouped bills feed, so every list
 * in the app is narrowed through the same control. The sticky wrapper and the
 * count line stay with the caller, which knows what it is counting.
 */
export function DataViewToolbar({
  search,
  onSearchChange,
  searchPlaceholder,
  searchLabel,
  onRefine,
  activeFilters,
  onRemoveFilter,
  trailing,
}: DataViewToolbarProps) {
  const { t } = useUiTranslation();
  return (
    <>
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search
            className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            type="search"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder={searchPlaceholder}
            aria-label={searchLabel}
            // `text-body` is 16px. The shared Input is `text-sm`, and iOS
            // zooms the page on focusing anything below 16px — a bug that
            // reads as "the app jumped" and never gets filed as one.
            className="ps-9 text-body"
          />
        </div>

        <Button
          variant="outline"
          onClick={onRefine}
          aria-label={t('ui.dataView.toolbar.refineAria')}
          className="shrink-0 gap-2"
        >
          <Sliders className="h-4 w-4" aria-hidden="true" />
          <span className="hidden sm:inline">{t('ui.dataView.toolbar.refine')}</span>
          {activeFilters.length > 0 ? (
            <Badge variant="secondary" className="tabular-nums">
              {activeFilters.length}
            </Badge>
          ) : null}
        </Button>

        {trailing}
      </div>

      {activeFilters.length > 0 ? (
        // `flex-wrap`, never `overflow-x-auto`: a chip pushed off the right
        // edge is a filter the user cannot see is applied.
        <div className="flex flex-wrap items-center gap-1.5">
          {activeFilters.map((filter) => (
            <button
              key={filter.key}
              type="button"
              onClick={() => onRemoveFilter(filter.key)}
              aria-label={t('ui.dataView.toolbar.removeFilter', {
                label: filter.label,
                value: filter.value,
              })}
              className={cn(
                // `border-border-strong`, not `border-border`: since V3-23
                // the plain token is the decorative hairline and owes no
                // contrast floor, and this border is the only thing saying
                // a chip is a control you can press to remove the filter.
                'inline-flex max-w-full items-center gap-1 rounded-md border border-border-strong px-2 py-1',
                'text-caption transition-colors duration-fast ease-emphasized hover:bg-surface-hover',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2'
              )}
            >
              <span className="truncate">
                <span className="text-muted-foreground">{filter.label}: </span>
                {filter.value}
              </span>
              <X className="h-3 w-3 shrink-0" aria-hidden="true" />
            </button>
          ))}
        </div>
      ) : null}
    </>
  );
}
