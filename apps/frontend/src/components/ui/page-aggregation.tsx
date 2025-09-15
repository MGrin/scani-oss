import { Search } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from './button';
import { Card, CardContent } from './card';
import { Input } from './input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select';
import { SummaryCard } from './summary-cards';

interface FilterOption {
  value: string;
  label: string;
}

interface PageAggregationProps {
  // Entity counts
  totalCount: number;
  filteredCount?: number;
  entityLabel: string; // "institutions", "accounts", "holdings", etc.

  // Financial totals
  totalBalance: number;
  filteredBalance?: number;
  baseCurrency?: string;

  // Search functionality
  searchTerm: string;
  onSearchChange: (term: string) => void;
  searchPlaceholder: string;

  // Filter functionality
  filterBy?: string;
  onFilterChange?: (value: string) => void;
  filterOptions?: FilterOption[];
  filterLabel?: string;
  customFilter?: ReactNode;

  // Additional controls
  extraActions?: ReactNode;
}

export function PageAggregation({
  totalCount,
  filteredCount,
  entityLabel,
  totalBalance,
  filteredBalance,
  baseCurrency,
  searchTerm,
  onSearchChange,
  searchPlaceholder,
  filterBy,
  onFilterChange,
  filterOptions,
  filterLabel,
  customFilter,
  extraActions,
}: PageAggregationProps) {
  const isFiltered = searchTerm || (filterBy && filterBy !== 'all');
  const displayCount = isFiltered ? (filteredCount ?? totalCount) : totalCount;
  const displayBalance = isFiltered ? (filteredBalance ?? totalBalance) : totalBalance;

  return (
    <div className="space-y-4">
      {/* Search and Filters */}
      {totalCount > 0 && (
        <Card>
          <CardContent className="p-3">
            <div className="flex flex-col space-y-3 md:flex-row md:space-y-0 md:space-x-3">
              {/* Search */}
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder={searchPlaceholder}
                  className="pl-10 h-9 text-sm"
                  value={searchTerm}
                  onChange={(e) => onSearchChange(e.target.value)}
                />
              </div>

              {/* Filter */}
              {customFilter ||
                (filterOptions && onFilterChange && (
                  <div className="md:w-48">
                    <Select value={filterBy} onValueChange={onFilterChange}>
                      <SelectTrigger className="h-9 text-sm">
                        <SelectValue placeholder={filterLabel || 'Filter'} />
                      </SelectTrigger>
                      <SelectContent>
                        {filterOptions.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ))}

              {/* Extra Actions */}
              {extraActions && <div className="flex items-center space-x-2">{extraActions}</div>}
            </div>

            {/* Search Results Info */}
            {(searchTerm || (filterBy && filterBy !== 'all')) && (
              <div className="flex items-center justify-between mt-2 pt-2 border-t">
                <p className="text-xs text-muted-foreground">
                  {displayCount} of {totalCount} {entityLabel} match your criteria
                </p>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    onSearchChange('');
                    if (onFilterChange) onFilterChange('all');
                  }}
                  className="text-xs h-6 px-2"
                >
                  Clear filters
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Summary Cards */}
      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
        {/* Total Balance */}
        <SummaryCard
          type="currency"
          title={isFiltered ? 'Filtered Balance' : 'Total Balance'}
          value={displayBalance}
          currency={baseCurrency}
          subtitle={isFiltered ? 'Based on current filters' : `All ${entityLabel} combined`}
        />

        {/* Entity Count */}
        <SummaryCard
          type="count"
          title={isFiltered ? `Filtered ${entityLabel}` : `Total ${entityLabel}`}
          value={displayCount}
          label={entityLabel.toLowerCase()}
          subtitle={isFiltered ? 'Found with filters' : 'Across your portfolio'}
        />

        {/* Optional third summary card can be added by consumers */}
      </div>
    </div>
  );
}
