import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import type { ReactNode } from 'react';

import { Checkbox } from '@/components/ui/checkbox';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';

export interface ColumnDef<T> {
  key: string;
  header?: string;
  /** Alias for header */
  label?: string;
  render?: (item: T) => ReactNode;
  sortable?: boolean;
  className?: string;
  align?: 'left' | 'right' | 'center';
  width?: string;
}

interface DataViewTableProps<T> {
  data: T[];
  columns: ColumnDef<T>[];
  getId: (item: T) => string;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  isAllSelected: boolean;
  sortField: string;
  sortDirection: 'asc' | 'desc';
  onSetSort: (field: string) => void;
  onRowClick?: (item: T) => void;
  groupLabel?: string;
}

function SortIcon({
  field,
  sortField,
  sortDirection,
}: {
  field: string;
  sortField: string;
  sortDirection: 'asc' | 'desc';
}) {
  if (field !== sortField) return <ArrowUpDown className="ml-1 h-3 w-3 opacity-40" />;
  return sortDirection === 'asc' ? (
    <ArrowUp className="ml-1 h-3 w-3" />
  ) : (
    <ArrowDown className="ml-1 h-3 w-3" />
  );
}

export function DataViewTable<T>({
  data,
  columns,
  getId,
  selectedIds,
  onToggleSelect,
  onSelectAll,
  onClearSelection,
  isAllSelected,
  sortField,
  sortDirection,
  onSetSort,
  onRowClick,
  groupLabel,
}: DataViewTableProps<T>) {
  const hasSelection = selectedIds.size > 0;

  return (
    <div>
      {groupLabel && (
        <h3 className="mb-2 mt-4 text-sm font-semibold text-muted-foreground">{groupLabel}</h3>
      )}
      <div className="overflow-x-auto">
        <Table className="min-w-[700px]">
          <TableHeader>
            <TableRow>
              <TableHead className="w-[40px]">
                <Checkbox
                  checked={isAllSelected}
                  onCheckedChange={() => (hasSelection ? onClearSelection() : onSelectAll())}
                  aria-label="Select all"
                />
              </TableHead>
              {columns.map((col) => (
                <TableHead
                  key={col.key}
                  className={cn(
                    col.width,
                    col.className,
                    col.sortable && 'cursor-pointer select-none'
                  )}
                  onClick={col.sortable ? () => onSetSort(col.key) : undefined}
                >
                  <div className="flex items-center">
                    {col.header || col.label || col.key}
                    {col.sortable && (
                      <SortIcon
                        field={col.key}
                        sortField={sortField}
                        sortDirection={sortDirection}
                      />
                    )}
                  </div>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((item) => {
              const id = getId(item);
              const isSelected = selectedIds.has(id);
              return (
                <TableRow
                  key={id}
                  data-state={isSelected ? 'selected' : undefined}
                  className={cn(onRowClick && 'cursor-pointer')}
                  onClick={() => onRowClick?.(item)}
                >
                  {/* The whole cell is a hit target for selection, not
                      just the ~16px checkbox. Stopping propagation on the
                      cell (and padding it out) prevents the common
                      mis-tap where the user aims at the checkbox and
                      instead triggers the row-level navigation. */}
                  <TableCell
                    className="cursor-pointer"
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleSelect(id);
                    }}
                  >
                    <Checkbox
                      checked={isSelected}
                      onCheckedChange={() => onToggleSelect(id)}
                      onClick={(e) => e.stopPropagation()}
                      aria-label={`Select row ${id}`}
                    />
                  </TableCell>
                  {columns.map((col) => (
                    <TableCell key={col.key} className={cn(col.width, col.className)}>
                      {col.render
                        ? col.render(item)
                        : String((item as Record<string, unknown>)[col.key] ?? '')}
                    </TableCell>
                  ))}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
