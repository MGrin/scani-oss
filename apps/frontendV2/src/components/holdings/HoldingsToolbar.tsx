import { Grid3X3, List } from 'lucide-react';
import {
  AccountFilterSelector,
  TokenFilterSelector,
  TokenTypeSelector,
} from '@/components/selectors/SearchableSelectors';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { PageAggregation } from '@/components/ui/page-aggregation';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { GroupBy } from '@/hooks/useHoldingFilters';

interface HoldingsToolbarProps {
  totalCount: number;
  filteredCount: number;
  summaryStats: { totalValue: number; holdingCount: number };
  currency: string;
  searchTerm: string;
  onSearchChange: (value: string) => void;
  filterBy: string;
  filterByAccount: string;
  filterByToken: string;
  filterByGroup: string;
  valueRange: string;
  groupBy: GroupBy;
  viewMode: 'cards' | 'table';
  tokenTypes: { id: string; code: string; name: string }[];
  accountOptions: {
    id: string;
    name: string;
    typeName: string;
    institutionId: string;
  }[];
  institutionOptions: {
    id: string;
    name: string;
    type: string;
    typeCode: string;
    website: string | null;
  }[];
  tokenOptions: {
    id: string;
    symbol: string;
    name: string;
    type: string;
    typeName: string;
    iconUrl: string | null;
  }[];
  groups: { id: string; name: string }[];
  updateFilter: (key: string, value: string) => void;
  setValueRange: (value: string) => void;
  setGroupBy: (value: GroupBy) => void;
  setViewMode: (value: 'cards' | 'table') => void;
  clearFilters: () => void;
}

export function HoldingsToolbar({
  totalCount,
  filteredCount,
  summaryStats,
  currency,
  searchTerm,
  onSearchChange,
  filterBy,
  filterByAccount,
  filterByToken,
  filterByGroup,
  valueRange,
  groupBy,
  viewMode,
  tokenTypes,
  accountOptions,
  institutionOptions,
  tokenOptions,
  groups,
  updateFilter,
  setValueRange,
  setGroupBy,
  setViewMode,
  clearFilters,
}: HoldingsToolbarProps) {
  return (
    <PageAggregation
      totalCount={totalCount}
      filteredCount={filteredCount}
      entityLabel="holdings"
      totalBalance={summaryStats.totalValue}
      filteredBalance={summaryStats.totalValue} // For now, same as total since we don't have filtered value calculation
      baseCurrency={currency}
      searchTerm={searchTerm}
      onSearchChange={onSearchChange}
      searchPlaceholder="Search holdings by token name, symbol, or account..."
      hasActiveFilters={
        filterBy !== '' ||
        filterByAccount !== '' ||
        filterByToken !== '' ||
        filterByGroup !== '' ||
        valueRange !== 'all'
      }
      filters={[
        <TokenTypeSelector
          key="type"
          value={filterBy}
          onValueChange={(value) => updateFilter('type', value)}
          tokenTypes={tokenTypes}
          placeholder="Filter by type..."
        />,
        <AccountFilterSelector
          key="account"
          value={filterByAccount}
          onValueChange={(value) => updateFilter('account', value)}
          accounts={accountOptions}
          institutions={institutionOptions}
          placeholder="Filter by account..."
          includeAllOption={false}
        />,
        <TokenFilterSelector
          key="token"
          value={filterByToken}
          onValueChange={(value) => updateFilter('token', value)}
          tokens={tokenOptions}
          placeholder="Filter by token..."
          includeAllOption={false}
        />,
        <Combobox
          key="group"
          value={filterByGroup}
          onValueChange={(value: string) => updateFilter('group', value)}
          items={
            groups?.map((group) => ({
              value: group.id,
              label: group.name,
            })) || []
          }
          placeholder="Filter by group..."
          buttonSize="sm"
        />,
      ]}
      extraActions={
        <div className="flex items-center gap-2">
          <Button
            variant={viewMode === 'cards' ? 'default' : 'outline'}
            size="sm"
            onClick={() => setViewMode('cards')}
          >
            <Grid3X3 className="h-4 w-4 mr-2" />
            Cards
          </Button>
          <Button
            variant={viewMode === 'table' ? 'default' : 'outline'}
            size="sm"
            onClick={() => setViewMode('table')}
          >
            <List className="h-4 w-4 mr-2" />
            Table
          </Button>
        </div>
      }
      additionalControls={
        <div className="flex flex-col md:flex-row items-start md:items-center gap-2 w-full">
          <Select value={valueRange} onValueChange={setValueRange}>
            <SelectTrigger className="w-full md:w-40">
              <SelectValue placeholder="All Values" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Values</SelectItem>
              <SelectItem value="under-1k">Under $1K</SelectItem>
              <SelectItem value="1k-10k">$1K - $10K</SelectItem>
              <SelectItem value="10k-100k">$10K - $100K</SelectItem>
              <SelectItem value="over-100k">Over $100K</SelectItem>
            </SelectContent>
          </Select>

          <Select value={groupBy} onValueChange={(value: GroupBy) => setGroupBy(value)}>
            <SelectTrigger className="w-full md:w-40">
              <SelectValue placeholder="Group by..." />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No Grouping</SelectItem>
              <SelectItem value="institution">By Institution</SelectItem>
              <SelectItem value="account">By Account</SelectItem>
              <SelectItem value="tokenType">By Token Type</SelectItem>
            </SelectContent>
          </Select>

          <div className="ml-auto">
            <Button variant="outline" size="sm" onClick={clearFilters}>
              Clear Filters
            </Button>
          </div>
        </div>
      }
    />
  );
}
