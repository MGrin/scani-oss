import { Inbox } from 'lucide-react';
import type { ReactNode } from 'react';

import { Skeleton } from '@/components/ui/skeleton';
import { type DataViewConfig, useDataView } from '../../hooks/useDataView';
import { EmptyState } from '../shared/EmptyState';
import { DataViewCards } from './DataViewCards';
import type { ColumnDef } from './DataViewTable';
import { DataViewTable } from './DataViewTable';
import { DataViewToolbar } from './DataViewToolbar';

interface DataViewProps<T> {
  config: DataViewConfig<T>;
  columns: ColumnDef<T>[];
  renderCard: (item: T, isSelected: boolean, onSelect: () => void) => ReactNode;
  renderBulkActions?: (selectedIds: Set<string>, clearSelection: () => void) => ReactNode;
  onRowClick?: (item: T) => void;
  emptyState?: ReactNode;
  getId: (item: T) => string;
  isLoading?: boolean;
}

const SKELETON_KEYS = ['sk-a', 'sk-b', 'sk-c', 'sk-d', 'sk-e'];

function LoadingSkeleton() {
  return (
    <div className="space-y-3 py-4">
      {SKELETON_KEYS.map((key) => (
        <Skeleton key={key} className="h-12 w-full" />
      ))}
    </div>
  );
}

// biome-ignore lint/suspicious/noShadowRestrictedNames: DataView is the correct domain name for this component
export function DataView<T>({
  config,
  columns,
  renderCard,
  renderBulkActions,
  onRowClick,
  emptyState,
  getId,
  isLoading,
}: DataViewProps<T>) {
  const dv = useDataView(config, getId);

  if (isLoading) {
    return <LoadingSkeleton />;
  }

  const renderContent = (items: T[], groupLabel?: string) => {
    if (dv.viewMode === 'table') {
      return (
        <DataViewTable
          data={items}
          columns={columns}
          getId={getId}
          selectedIds={dv.selectedIds}
          onToggleSelect={dv.toggleSelect}
          onSelectAll={dv.selectAll}
          onClearSelection={dv.clearSelection}
          isAllSelected={dv.isAllSelected}
          sortField={dv.sortField}
          sortDirection={dv.sortDirection}
          onSetSort={dv.setSort}
          onRowClick={onRowClick}
          groupLabel={groupLabel}
        />
      );
    }
    return (
      <DataViewCards
        data={items}
        getId={getId}
        selectedIds={dv.selectedIds}
        onToggleSelect={dv.toggleSelect}
        renderCard={renderCard}
        onCardClick={onRowClick}
        groupLabel={groupLabel}
      />
    );
  };

  const isEmpty = dv.filteredData.length === 0;

  return (
    <div className="space-y-4">
      <div className="sticky top-0 z-10 bg-background pb-2 -mt-2 pt-2">
        <DataViewToolbar
          searchTerm={dv.searchTerm}
          onSearchChange={dv.setSearchTerm}
          filters={dv.filters}
          filterDefs={config.filterDefs}
          onSetFilter={dv.setFilter}
          onClearFilters={dv.clearFilters}
          hasActiveFilters={dv.hasActiveFilters}
          sortField={dv.sortField}
          sortDirection={dv.sortDirection}
          sortDefs={config.sortDefs}
          onSetSort={dv.setSort}
          groupBy={dv.groupBy}
          groupByDefs={config.groupByDefs}
          onSetGroupBy={dv.setGroupBy}
          viewMode={dv.viewMode}
          onSetViewMode={dv.setViewMode}
          totalCount={dv.totalCount}
          filteredCount={dv.filteredCount}
        />
      </div>

      {isEmpty &&
        (emptyState ?? (
          <EmptyState
            icon={Inbox}
            title="No items found"
            description={
              dv.hasActiveFilters ? 'Try adjusting your filters or search term.' : undefined
            }
          />
        ))}

      {!isEmpty && dv.groupedData
        ? Array.from(dv.groupedData.entries()).map(([label, items]) => renderContent(items, label))
        : !isEmpty && renderContent(dv.filteredData)}

      {/* Bulk action bar — pinned above the mobile bottom nav via fixed
          positioning so it stays put when iOS toggles the visual viewport
          (keyboard open/close). On desktop (no MobileNav), it sticks at
          the bottom of the content area. */}
      {dv.selectedIds.size > 0 && renderBulkActions && (
        <div className="fixed inset-x-0 z-30 px-4 bottom-[calc(3.5rem+env(safe-area-inset-bottom,0px))] lg:sticky lg:inset-x-auto lg:bottom-0 lg:px-0">
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-background p-3 shadow-lg">
            <span className="text-sm font-medium shrink-0">{dv.selectedIds.size} selected</span>
            <div className="flex flex-wrap items-center justify-end gap-2">
              {renderBulkActions(dv.selectedIds, dv.clearSelection)}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
