import { ArrowUpDown } from 'lucide-react';
import type { ReactNode } from 'react';
import { Card, CardContent } from './card';
import { Checkbox } from './checkbox';
import { Skeleton } from './skeleton';

export interface Column<T> {
  header: string;
  accessor: keyof T | ((row: T) => ReactNode);
  sortable?: boolean;
  className?: string;
  headerClassName?: string;
}

export interface DataTableProps<T> {
  data: T[];
  columns: Column<T>[];
  isLoading?: boolean;
  onSort?: (field: string) => void;
  sortField?: string;
  sortDirection?: 'asc' | 'desc';
  emptyMessage?: string;
  loadingRowCount?: number;
  getRowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  actions?: (row: T) => ReactNode;
  // Selection props
  selectable?: boolean;
  selectedRows?: Set<string>;
  onSelectRow?: (rowKey: string) => void;
  onSelectAll?: (selected: boolean) => void;
}

export function DataTable<T>({
  data,
  columns,
  isLoading = false,
  onSort,
  emptyMessage = 'No data available',
  loadingRowCount = 4,
  getRowKey,
  onRowClick,
  actions,
  selectable = false,
  selectedRows = new Set(),
  onSelectRow,
  onSelectAll,
}: DataTableProps<T>) {
  const handleSort = (column: Column<T>) => {
    if (!column.sortable || !onSort) return;

    // Convert accessor to string for sorting
    const field =
      typeof column.accessor === 'function'
        ? column.header.toLowerCase().replace(/\s+/g, '_')
        : String(column.accessor);

    onSort(field);
  };

  const getCellValue = (row: T, column: Column<T>): ReactNode => {
    if (typeof column.accessor === 'function') {
      return column.accessor(row);
    }
    return row[column.accessor] as ReactNode;
  };

  const allSelected =
    selectable && data.length > 0 && data.every((row) => selectedRows.has(getRowKey(row)));

  const handleSelectAllChange = (checked: boolean) => {
    onSelectAll?.(checked);
  };

  const handleSelectRowChange = (rowKey: string) => {
    onSelectRow?.(rowKey);
  };

  if (isLoading) {
    return (
      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto max-w-[calc(100vw-2rem)]">
            <table className="w-full">
              <thead className="border-b bg-muted/50">
                <tr className="text-left">
                  {selectable && (
                    <th className="p-4 font-medium whitespace-nowrap w-12">
                      <Skeleton className="h-4 w-4" />
                    </th>
                  )}
                  {columns.map((column) => (
                    <th
                      key={column.header}
                      className={`p-4 font-medium whitespace-nowrap ${
                        column.headerClassName || ''
                      }`}
                    >
                      <Skeleton className="h-4 w-20" />
                    </th>
                  ))}
                  {actions && (
                    <th className="p-4 font-medium whitespace-nowrap w-12">
                      <Skeleton className="h-4 w-4" />
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: loadingRowCount }).map((_, rowIndex) => (
                  <tr
                    key={`skeleton-row-${
                      // biome-ignore lint/suspicious/noArrayIndexKey: this is just for loading state
                      rowIndex
                    }`}
                    className="border-b"
                  >
                    {selectable && (
                      <td className="p-4 whitespace-nowrap">
                        <Skeleton className="h-4 w-4" />
                      </td>
                    )}
                    {columns.map((column) => (
                      <td
                        key={`skeleton-cell-${rowIndex}-${column.header}`}
                        className="p-4 whitespace-nowrap"
                      >
                        <Skeleton className="h-4 w-full" />
                      </td>
                    ))}
                    {actions && (
                      <td className="p-4 whitespace-nowrap">
                        <Skeleton className="h-4 w-4" />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (data.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center">
          <p className="text-muted-foreground">{emptyMessage}</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="p-0">
        <div className="overflow-x-auto max-w-[calc(100vw-2rem)]">
          <table className="w-full">
            <thead className="border-b bg-muted/50">
              <tr className="text-left">
                {selectable && (
                  <th className="p-4 font-medium whitespace-nowrap w-12">
                    <Checkbox
                      checked={allSelected}
                      onCheckedChange={handleSelectAllChange}
                      aria-label="Select all rows"
                    />
                  </th>
                )}
                {columns.map((column) => (
                  <th
                    key={column.header}
                    className={`p-4 font-medium whitespace-nowrap ${
                      column.sortable ? 'cursor-pointer hover:bg-muted/70' : ''
                    } ${column.headerClassName || ''}`}
                    onClick={() => handleSort(column)}
                  >
                    <div className="flex items-center gap-2">
                      {column.header}
                      {column.sortable && <ArrowUpDown className="h-4 w-4" />}
                    </div>
                  </th>
                ))}
                {actions && (
                  <th className="p-4 font-medium whitespace-nowrap w-12">
                    <span className="sr-only">Actions</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {data.map((row) => {
                const rowKey = getRowKey(row);
                const isSelected = selectedRows.has(rowKey);
                return (
                  <tr
                    key={rowKey}
                    className={`border-b hover:bg-muted/50 transition-colors ${
                      onRowClick ? 'cursor-pointer' : ''
                    } ${isSelected ? 'bg-muted/30' : ''}`}
                    onClick={() => onRowClick?.(row)}
                  >
                    {selectable && (
                      <td
                        className="p-4 whitespace-nowrap"
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.stopPropagation();
                            e.preventDefault();
                          }
                        }}
                      >
                        <Checkbox
                          checked={isSelected}
                          onCheckedChange={() => handleSelectRowChange(rowKey)}
                          aria-label={`Select row ${rowKey}`}
                        />
                      </td>
                    )}
                    {columns.map((column) => (
                      <td
                        key={`${rowKey}-${column.header}`}
                        className={`p-4 whitespace-nowrap ${column.className || ''}`}
                      >
                        {getCellValue(row, column)}
                      </td>
                    ))}
                    {actions && <td className="p-4 whitespace-nowrap">{actions(row)}</td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
