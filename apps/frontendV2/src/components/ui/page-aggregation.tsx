import { Search } from 'lucide-react';
import type { ReactNode } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { SummaryCard } from '@/components/ui/summary-card';

interface PageAggregationProps {
  totalCount: number;
  filteredCount: number;
  entityLabel: string;
  totalBalance?: number;
  filteredBalance?: number;
  baseCurrency?: string;
  searchTerm: string;
  onSearchChange: (value: string) => void;
  searchPlaceholder?: string;
  hasActiveFilters?: boolean;
  filters?: ReactNode[];
  extraActions?: ReactNode;
  additionalControls?: ReactNode;
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
  searchPlaceholder = 'Search...',
  hasActiveFilters = false,
  filters = [],
  extraActions,
  additionalControls,
  isAffectedByUnpriceableTokens = false,
}: PageAggregationProps) {
  const isFiltered = searchTerm || hasActiveFilters;
  const displayCount = isFiltered && filteredCount !== undefined ? filteredCount : totalCount;
  const displayBalance =
    isFiltered && filteredBalance !== undefined ? filteredBalance : totalBalance;

  return (
    <div className="space-y-4">
      {/* Summary Cards - Show on top when there's data */}
      {totalCount > 0 && (
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {/* Total Balance */}
          {totalBalance !== undefined && (
            <SummaryCard
              type="currency"
              title={isFiltered ? 'Filtered Balance' : 'Total Balance'}
              value={displayBalance || 0}
              currency={baseCurrency}
              subtitle={isFiltered ? 'Based on current filters' : `All ${entityLabel} combined`}
              isAffectedByUnpriceableTokens={isAffectedByUnpriceableTokens}
            />
          )}

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

      {/* Search and Filters */}
      <Card>
        <CardContent className="p-3">
          <div className="space-y-3">
            {/* First Line: Search bar and card/table switcher */}
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

            {/* Second Line: Type, Account and Token filters */}
            {filters && filters.length > 0 && (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                {filters.map((filter, index) => {
                  // Try to extract a more stable key from the React element
                  const key =
                    typeof filter === 'object' && filter && 'key' in filter && filter.key
                      ? String(filter.key)
                      : `filter-component-${index}`;
                  return <div key={key}>{filter}</div>;
                })}
              </div>
            )}

            {/* Third Line: Additional controls (Values, Grouping, Clear Filter) */}
            {additionalControls && (
              <div className="flex flex-wrap items-center gap-2 pt-2 border-t">
                {additionalControls}
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
