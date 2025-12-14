import { Building2, Grid3X3, List } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DataTable } from '@/components/ui/data-table';
import { MoneyDisplay } from '@/components/ui/money-display';
import { PageAggregation } from '@/components/ui/page-aggregation';
import { PageHeader } from '@/components/ui/page-header';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { useViewMode } from '@/hooks/use-view-mode';
import { trpc } from '@/lib/trpc';
import { createCurrencyToken } from '@/lib/utils';

export function Institutions() {
  const navigate = useNavigate();

  // Fetch institutions with summary data
  const { data: institutions, isLoading } = trpc.institutions.getByUserIdWithSummary.useQuery();

  // Fetch institution types for display
  const { data: institutionTypes } = trpc.institutionTypes.getAll.useQuery();

  // Fetch base currency for money display
  const { data: baseCurrency } = trpc.users.getBaseCurrency.useQuery();
  const currency = baseCurrency?.symbol || 'USD';
  const baseCurrencyToken = createCurrencyToken(currency);

  // State for filtering, sorting, and view mode
  const [searchTerm, setSearchTerm] = useState('');
  const [filterByType, setFilterByType] = useState('');
  const [valueRange, setValueRange] = useState('all');
  const [viewMode, setViewMode] = useViewMode('cards');
  const [sortField, setSortField] = useState('value');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');

  // Filter and sort institutions
  const filteredAndSortedInstitutions = useMemo(() => {
    if (!institutions) return [];

    const filtered = institutions.filter((institution) => {
      const institutionType = institutionTypes?.find((type) => type.id === institution.typeId);

      const matchesSearch =
        searchTerm === '' ||
        institution.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        institutionType?.name.toLowerCase().includes(searchTerm.toLowerCase());

      const matchesType = filterByType === '' || institution.typeId === filterByType;

      // Value range filter
      let matchesValueRange = true;
      if (valueRange !== 'all') {
        const value = parseFloat(institution.summary.totalValue);
        switch (valueRange) {
          case 'under-1k':
            matchesValueRange = value < 1000;
            break;
          case '1k-10k':
            matchesValueRange = value >= 1000 && value < 10000;
            break;
          case '10k-100k':
            matchesValueRange = value >= 10000 && value < 100000;
            break;
          case 'over-100k':
            matchesValueRange = value >= 100000;
            break;
        }
      }

      return matchesSearch && matchesType && matchesValueRange;
    });

    // Sort institutions
    filtered.sort((a, b) => {
      let aValue: number | string, bValue: number | string;

      switch (sortField) {
        case 'name':
          aValue = a.name.toLowerCase();
          bValue = b.name.toLowerCase();
          break;
        case 'accounts':
          aValue = a.summary.accountCount;
          bValue = b.summary.accountCount;
          break;
        default:
          aValue = parseFloat(a.summary.totalValue);
          bValue = parseFloat(b.summary.totalValue);
      }

      if (typeof aValue === 'string') {
        return sortDirection === 'asc'
          ? aValue.localeCompare(bValue as string)
          : (bValue as string).localeCompare(aValue);
      }

      return sortDirection === 'asc'
        ? (aValue as number) - (bValue as number)
        : (bValue as number) - (aValue as number);
    });

    return filtered;
  }, [
    institutions,
    searchTerm,
    filterByType,
    valueRange,
    sortField,
    sortDirection,
    institutionTypes,
  ]);

  // Calculate summary statistics
  const summaryStats = useMemo(() => {
    const totalValue = (institutions || []).reduce(
      (sum, inst) => sum + parseFloat(inst.summary.totalValue),
      0
    );
    const filteredValue = filteredAndSortedInstitutions.reduce(
      (sum, inst) => sum + parseFloat(inst.summary.totalValue),
      0
    );

    return {
      totalValue,
      filteredValue,
      institutionCount: filteredAndSortedInstitutions.length,
    };
  }, [institutions, filteredAndSortedInstitutions]);

  const handleSort = (field: string) => {
    if (sortField === field) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('desc');
    }
  };

  const clearFilters = () => {
    setSearchTerm('');
    setFilterByType('');
    setValueRange('all');
    setSortField('value');
    setSortDirection('desc');
  };

  // Create a Map for efficient institution type lookups
  const institutionTypeMap = useMemo(() => {
    if (!institutionTypes) return new Map();
    return new Map(institutionTypes.map((type) => [type.id, type]));
  }, [institutionTypes]);

  if (isLoading) {
    return (
      <div className="space-y-6">
        <PageHeader title="Institutions" subtitle="Your financial institutions" />
        <div className="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3, 4, 5, 6].map((num) => (
            <Card key={`skeleton-${num}`} className="min-h-[160px]">
              <CardHeader>
                <Skeleton className="h-6 w-32" />
                <Skeleton className="h-4 w-20" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-8 w-24 mb-2" />
                <Skeleton className="h-4 w-16" />
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader title="Institutions" subtitle="Your financial institutions" />

      {institutions && institutions.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Building2 className="h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold mb-2">No institutions yet</h3>
            <p className="text-muted-foreground text-center mb-4">
              Add your first financial institution to start tracking your accounts and holdings.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Page Aggregation with Search and Filters */}
          <PageAggregation
            totalCount={institutions?.length || 0}
            filteredCount={filteredAndSortedInstitutions.length}
            entityLabel="institutions"
            totalBalance={summaryStats.totalValue}
            filteredBalance={summaryStats.filteredValue}
            baseCurrency={currency}
            searchTerm={searchTerm}
            onSearchChange={setSearchTerm}
            searchPlaceholder="Search institutions by name or type..."
            hasActiveFilters={filterByType !== '' || valueRange !== 'all'}
            filters={[
              <Select key="type" value={filterByType} onValueChange={setFilterByType}>
                <SelectTrigger className="w-full md:w-[200px]">
                  <SelectValue placeholder="All Types" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">All Types</SelectItem>
                  {institutionTypes?.map((type) => (
                    <SelectItem key={type.id} value={type.id}>
                      {type.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>,
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
              <div className="flex items-center gap-2 w-full">
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

                <div className="ml-auto">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={clearFilters}
                    disabled={searchTerm === '' && filterByType === '' && valueRange === 'all'}
                  >
                    Clear Filters
                  </Button>
                </div>
              </div>
            }
          />

          {/* Institutions Display */}
          {viewMode === 'table' ? (
            <DataTable
              data={filteredAndSortedInstitutions}
              columns={[
                {
                  header: 'Institution',
                  accessor: (row) => (
                    <div>
                      <div className="font-medium">{row.name}</div>
                      <div className="text-sm text-muted-foreground">
                        {institutionTypeMap.get(row.typeId)?.name || 'Unknown Type'}
                      </div>
                    </div>
                  ),
                  sortable: true,
                },
                {
                  header: 'Accounts',
                  accessor: (row) =>
                    `${row.summary.accountCount} account${
                      row.summary.accountCount !== 1 ? 's' : ''
                    }`,
                  className: 'text-muted-foreground',
                  sortable: true,
                },
                {
                  header: 'Total Value',
                  accessor: (row) => (
                    <MoneyDisplay value={row.summary.totalValue} token={baseCurrencyToken} />
                  ),
                  className: 'font-mono font-medium',
                  sortable: true,
                },
              ]}
              getRowKey={(row) => row.id}
              onRowClick={(row) => navigate(`/institutions/${row.id}`)}
              onSort={handleSort}
              sortField={sortField}
              sortDirection={sortDirection}
            />
          ) : (
            <div className="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
              {filteredAndSortedInstitutions.map((institution) => {
                const institutionType = institutionTypeMap.get(institution.typeId);

                return (
                  <Card
                    key={institution.id}
                    className="hover:shadow-md transition-shadow cursor-pointer min-h-[160px]"
                    onClick={() => navigate(`/institutions/${institution.id}`)}
                  >
                    <CardHeader>
                      <CardTitle className="flex items-center justify-between">
                        <span className="truncate">{institution.name}</span>
                        <div className="text-sm text-muted-foreground ml-2">
                          {institutionType?.name || 'Unknown'}
                        </div>
                      </CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="space-y-2">
                        <div>
                          <p className="text-sm text-muted-foreground">Total Value</p>
                          <div className="text-xl font-semibold">
                            <MoneyDisplay
                              value={institution.summary.totalValue}
                              token={baseCurrencyToken}
                            />
                          </div>
                        </div>
                        <div>
                          <p className="text-sm text-muted-foreground">
                            {institution.summary.accountCount} account
                            {institution.summary.accountCount !== 1 ? 's' : ''}
                          </p>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
