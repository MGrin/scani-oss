import { Grid3X3, List } from 'lucide-react';
import {
  AccountTypeSelector,
  InstitutionSelector,
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

type GroupBy = 'none' | 'institution' | 'type';

interface AccountsToolbarProps {
  totalCount: number;
  filteredCount: number;
  summaryTotalValue: number;
  baseCurrency: string;
  searchTerm: string;
  onSearchChange: (value: string) => void;
  filterByType: string;
  filterByInstitution: string;
  filterByGroup: string;
  onFilterChange: (key: string, value: string) => void;
  accountTypeOptions: { id: string; name: string; code: string; description?: string | null }[];
  institutionOptions: {
    id: string;
    name: string;
    type: string;
    typeCode: string;
    website: string | null;
  }[];
  groupOptions: { value: string; label: string }[];
  valueRange: string;
  onValueRangeChange: (value: string) => void;
  groupBy: GroupBy;
  onGroupByChange: (value: GroupBy) => void;
  viewMode: 'cards' | 'table';
  onViewModeChange: (mode: 'cards' | 'table') => void;
  onClearFilters: () => void;
}

export function AccountsToolbar({
  totalCount,
  filteredCount,
  summaryTotalValue,
  baseCurrency,
  searchTerm,
  onSearchChange,
  filterByType,
  filterByInstitution,
  filterByGroup,
  onFilterChange,
  accountTypeOptions,
  institutionOptions,
  groupOptions,
  valueRange,
  onValueRangeChange,
  groupBy,
  onGroupByChange,
  viewMode,
  onViewModeChange,
  onClearFilters,
}: AccountsToolbarProps) {
  return (
    <PageAggregation
      totalCount={totalCount}
      filteredCount={filteredCount}
      entityLabel="accounts"
      totalBalance={summaryTotalValue}
      filteredBalance={summaryTotalValue}
      baseCurrency={baseCurrency}
      searchTerm={searchTerm}
      onSearchChange={onSearchChange}
      searchPlaceholder="Search accounts by name, institution, or type..."
      hasActiveFilters={
        filterByType !== '' ||
        filterByInstitution !== '' ||
        filterByGroup !== '' ||
        valueRange !== 'all'
      }
      filters={[
        <AccountTypeSelector
          key="type"
          value={filterByType}
          onValueChange={(value) => onFilterChange('type', value)}
          accountTypes={accountTypeOptions}
          placeholder="Filter by type..."
        />,
        <InstitutionSelector
          key="institution"
          value={filterByInstitution}
          onValueChange={(value) => onFilterChange('institution', value)}
          institutions={institutionOptions}
          placeholder="Filter by institution..."
        />,
        <Combobox
          key="group"
          value={filterByGroup}
          onValueChange={(value: string) => onFilterChange('group', value)}
          items={groupOptions}
          placeholder="Filter by group..."
          buttonSize="sm"
        />,
      ]}
      extraActions={
        <div className="flex items-center gap-2">
          <Button
            variant={viewMode === 'cards' ? 'default' : 'outline'}
            size="sm"
            onClick={() => onViewModeChange('cards')}
          >
            <Grid3X3 className="h-4 w-4 mr-2" />
            Cards
          </Button>
          <Button
            variant={viewMode === 'table' ? 'default' : 'outline'}
            size="sm"
            onClick={() => onViewModeChange('table')}
          >
            <List className="h-4 w-4 mr-2" />
            Table
          </Button>
        </div>
      }
      additionalControls={
        <div className="flex flex-col md:flex-row items-start md:items-center gap-2 w-full">
          <Select value={valueRange} onValueChange={onValueRangeChange}>
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

          <Select value={groupBy} onValueChange={(value: GroupBy) => onGroupByChange(value)}>
            <SelectTrigger className="w-full md:w-40">
              <SelectValue placeholder="Group by..." />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No Grouping</SelectItem>
              <SelectItem value="institution">By Institution</SelectItem>
              <SelectItem value="type">By Type</SelectItem>
            </SelectContent>
          </Select>

          <div className="ml-auto">
            <Button variant="outline" size="sm" onClick={onClearFilters}>
              Clear Filters
            </Button>
          </div>
        </div>
      }
    />
  );
}
