import { Search } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from './button';
import { Card, CardContent } from './card';
import { Input } from './input';
import { SummaryCard } from './summary-cards';

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

  // Unified filter system
  filters?: ReactNode[]; // Array of filter components
  hasActiveFilters?: boolean; // Whether any filters are active
  onClearFilters?: () => void; // Clear all filters handler

  // Additional controls
  extraActions?: ReactNode;

  // Unpriceable tokens highlighting
  isAffectedByUnpriceableTokens?: boolean;
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
  filters,
  hasActiveFilters = false,
  onClearFilters,
  extraActions,
  isAffectedByUnpriceableTokens,
}: PageAggregationProps) {
  const isFiltered = searchTerm || hasActiveFilters;
  const displayCount = isFiltered && filteredCount !== undefined ? filteredCount : totalCount;
  const displayBalance =
    isFiltered && filteredBalance !== undefined ? filteredBalance : totalBalance;

  return (
    <div className="space-y-4">
      {/* Search and Filters - Always show */}
      <Card>
        <CardContent className="p-3">
          <div className="space-y-3">
            {/* Search - First Line */}
            <div className="flex flex-col md:flex-row md:items-center gap-3">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder={searchPlaceholder}
                  className="pl-10 h-9 text-sm"
                  value={searchTerm}
                  onChange={(e) => onSearchChange(e.target.value)}
                />
              </div>

              {/* Extra Actions on same line as search */}
              {extraActions && <div className="flex items-center space-x-2">{extraActions}</div>}
            </div>

            {/* Filters - Second Line */}
            {filters && filters.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {filters.map((filter, index) => {
                  // Try to extract a more stable key from the React element
                  const key =
                    typeof filter === 'object' && filter && 'key' in filter && filter.key
                      ? String(filter.key)
                      : `filter-component-${index}`;
                  return (
                    <div key={key} className="w-full sm:max-w-[50%] sm:flex-1">
                      {filter}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Search Results Info */}
          {isFiltered && (
            <div className="flex items-center justify-between mt-2 pt-2 border-t">
              <p className="text-xs text-muted-foreground">
                {displayCount} of {totalCount} {entityLabel} match your criteria
              </p>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  onSearchChange('');
                  if (onClearFilters) {
                    onClearFilters();
                  }
                }}
                className="text-xs h-6 px-2"
              >
                Clear filters
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Summary Cards - Only show when there's data */}
      {totalCount > 0 && (
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {/* Total Balance */}
          <SummaryCard
            type="currency"
            title={isFiltered ? 'Filtered Balance' : 'Total Balance'}
            value={displayBalance}
            currency={baseCurrency}
            subtitle={isFiltered ? 'Based on current filters' : `All ${entityLabel} combined`}
            isAffectedByUnpriceableTokens={isAffectedByUnpriceableTokens}
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
      )}
    </div>
  );
}
