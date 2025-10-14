import {
  AlertTriangle,
  ArrowUpDown,
  Download,
  Filter,
  Grid3X3,
  List,
  MoreHorizontal,
  PieChart,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { AccountBadge, InstitutionBadge, TokenTypeBadge } from '@/components/features';
import {
  AccountFilterSelector,
  TokenFilterSelector,
  TokenTypeSelector,
} from '@/components/selectors/SearchableSelectors';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
import { Tabs, TabsContent } from '@/components/ui/tabs';
import { useFilters } from '@/hooks/use-filters';
import { trpc } from '@/lib/trpc';
import { createCurrencyToken } from '@/lib/utils';

type GroupBy = 'none' | 'institution' | 'account' | 'tokenType';
type ViewMode = 'cards' | 'table';

export function Holdings() {
  // Fetch holdings data from tRPC
  const { data: holdingsData, isLoading, error } = trpc.holdings.getWithDetails.useQuery();

  // Fetch base currency for proper formatting
  const { data: baseCurrency } = trpc.users.getBaseCurrency.useQuery();
  const currency = baseCurrency?.symbol || 'USD';
  const baseCurrencyToken = createCurrencyToken(currency);

  // Transform backend data to match frontend expectations
  const holdings =
    holdingsData?.map((holding) => ({
      ...holding,
      amount: parseFloat(holding.amount),
      value: parseFloat(holding.value),
      costBasis: parseFloat(holding.costBasis),
    })) || [];

  const [searchTerm, setSearchTerm] = useState('');
  const [groupBy, setGroupBy] = useState<GroupBy>('none');
  const [viewMode, setViewMode] = useState<ViewMode>('cards');
  const [sortField, setSortField] = useState('value');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const [valueRange, setValueRange] = useState('all');

  // Unified filter system
  const {
    filters: filterValues,
    updateFilter,
    clearAllFilters,
  } = useFilters([
    { key: 'type', defaultValue: 'all' },
    { key: 'account', defaultValue: 'all' },
    { key: 'token', defaultValue: 'all' },
  ]);

  const filterBy = filterValues.type || 'all';
  const filterByAccount = filterValues.account || 'all';
  const filterByToken = filterValues.token || 'all';

  // Get unique values for filters
  // Deduplicate institutions by ID
  const institutionMap = new Map();
  holdings.forEach((h) => {
    if (!institutionMap.has(h.institution.id)) {
      institutionMap.set(h.institution.id, h.institution);
    }
  });
  const institutions = Array.from(institutionMap.values());

  // Deduplicate accounts by ID
  const accountMap = new Map();
  holdings.forEach((h) => {
    if (!accountMap.has(h.account.id)) {
      accountMap.set(h.account.id, h.account);
    }
  });
  const accounts = Array.from(accountMap.values());

  // Deduplicate token types by code
  const tokenTypeMap = new Map();
  holdings.forEach((h) => {
    if (!tokenTypeMap.has(h.token.typeCode)) {
      tokenTypeMap.set(h.token.typeCode, {
        code: h.token.typeCode,
        name: h.token.type,
      });
    }
  });
  const tokenTypes = Array.from(tokenTypeMap.values());

  // Prepare data for SearchableSelectors
  const institutionOptions = institutions.map((inst) => ({
    id: inst.id,
    name: inst.name,
    type: inst.type,
  }));

  const accountOptions = accounts.map((acc) => ({
    id: acc.id,
    name: acc.name,
    typeName: acc.type,
    institutionId: 'dummy', // We don't have this in the current data structure
  }));

  // Deduplicate tokens by symbol
  const tokenMap = new Map();
  holdings.forEach((h) => {
    if (!tokenMap.has(h.token.symbol)) {
      tokenMap.set(h.token.symbol, h.token);
    }
  });
  const tokenOptions = Array.from(tokenMap.values()).map((token) => ({
    id: token.symbol, // Use symbol as ID for filtering
    symbol: token.symbol,
    name: token.name,
    type: token.typeCode,
  }));

  // Filter and sort holdings
  const filteredAndSortedHoldings = useMemo(() => {
    const filtered = holdings.filter((holding) => {
      const matchesSearch =
        searchTerm === '' ||
        holding.token.symbol.toLowerCase().includes(searchTerm.toLowerCase()) ||
        holding.token.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        holding.institution.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        holding.account.name.toLowerCase().includes(searchTerm.toLowerCase());

      const matchesTypeFilter = filterBy === 'all' || holding.token.typeCode === filterBy;
      const matchesAccountFilter =
        filterByAccount === 'all' || holding.account.id === filterByAccount;
      const matchesTokenFilter = filterByToken === 'all' || holding.token.symbol === filterByToken;

      // Value range filter
      let matchesValueRange = true;
      if (valueRange !== 'all') {
        const value = holding.value;
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

      return (
        matchesSearch &&
        matchesTypeFilter &&
        matchesAccountFilter &&
        matchesTokenFilter &&
        matchesValueRange
      );
    });

    // Sort holdings
    filtered.sort((a, b) => {
      // biome-ignore lint/suspicious/noExplicitAny: Dynamic sorting requires flexible typing for multiple field types
      let aValue: any, bValue: any;

      switch (sortField) {
        case 'value':
          aValue = a.value;
          bValue = b.value;
          break;
        case 'amount':
          aValue = a.amount;
          bValue = b.amount;
          break;
        case 'name':
          aValue = a.token.name.toLowerCase();
          bValue = b.token.name.toLowerCase();
          break;
        case 'institution':
          aValue = a.institution.name.toLowerCase();
          bValue = b.institution.name.toLowerCase();
          break;
        default:
          aValue = a.value;
          bValue = b.value;
      }

      if (typeof aValue === 'string') {
        return sortDirection === 'asc'
          ? aValue.localeCompare(bValue)
          : bValue.localeCompare(aValue);
      }

      return sortDirection === 'asc' ? aValue - bValue : bValue - aValue;
    });

    return filtered;
  }, [
    holdings,
    searchTerm,
    filterBy,
    filterByAccount,
    filterByToken,
    valueRange,
    sortField,
    sortDirection,
  ]);

  // Group holdings if needed
  const groupedHoldings =
    groupBy === 'none'
      ? { 'All Holdings': filteredAndSortedHoldings }
      : filteredAndSortedHoldings.reduce(
          (groups, holding) => {
            let key = '';
            switch (groupBy) {
              case 'institution':
                key = holding.institution.name;
                break;
              case 'account':
                key = holding.account.name;
                break;
              case 'tokenType':
                key = holding.token.type;
                break;
            }
            if (!groups[key]) groups[key] = [];
            groups[key]!.push(holding);
            return groups;
          },
          {} as Record<string, typeof filteredAndSortedHoldings>
        );

  // Calculate summary statistics
  const summaryStats = useMemo(() => {
    const totalValue = filteredAndSortedHoldings.reduce((sum, h) => sum + h.value, 0);

    return {
      totalValue,
      holdingCount: filteredAndSortedHoldings.length,
    };
  }, [filteredAndSortedHoldings]);

  const handleSort = (field: string) => {
    if (sortField === field) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('desc');
    }
  };

  const exportData = (format: 'csv' | 'json') => {
    const data = filteredAndSortedHoldings.map((h) => ({
      Institution: h.institution.name,
      Account: h.account.name,
      Token: h.token.name,
      Symbol: h.token.symbol,
      Type: h.token.type,
      Amount: h.amount,
      Value: h.value,
    }));

    if (format === 'csv') {
      if (data.length === 0 || !data[0]) return;

      const headers = Object.keys(data[0]).join(',');
      const rows = data.map((row) =>
        Object.values(row)
          .map((val) => `"${val}"`)
          .join(',')
      );
      const csv = [headers, ...rows].join('\n');

      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'holdings.csv';
      a.click();
      URL.revokeObjectURL(url);
    } else {
      const json = JSON.stringify(data, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'holdings.json';
      a.click();
      URL.revokeObjectURL(url);
    }
  };

  const clearFilters = () => {
    setSearchTerm('');
    clearAllFilters();
    setValueRange('all');
    setSortField('value');
    setSortDirection('desc');
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Holdings"
        subtitle="Explore all your financial positions"
        secondaryActions={
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                <Download className="h-4 w-4 mr-2" />
                Export
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onClick={() => exportData('csv')}>Export as CSV</DropdownMenuItem>
              <DropdownMenuItem onClick={() => exportData('json')}>Export as JSON</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        }
      />

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <div className="text-center">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto mb-4"></div>
            <p className="text-muted-foreground">Loading your holdings...</p>
          </div>
        </div>
      ) : error ? (
        <Card>
          <CardContent className="py-12 text-center">
            <div className="text-muted-foreground">
              <AlertTriangle className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <h3 className="text-lg font-medium mb-2">Error loading holdings</h3>
              <p>Unable to load your holdings data. Please try again later.</p>
            </div>
          </CardContent>
        </Card>
      ) : holdings.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <div className="text-muted-foreground">
              <PieChart className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <h3 className="text-lg font-medium mb-2">No holdings found</h3>
              <p>You don't have any holdings yet. Connect your accounts to get started.</p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Page Aggregation with Search and Filters */}
          <PageAggregation
            totalCount={holdings.length}
            filteredCount={filteredAndSortedHoldings.length}
            entityLabel="holdings"
            totalBalance={summaryStats.totalValue}
            filteredBalance={summaryStats.totalValue} // For now, same as total since we don't have filtered value calculation
            baseCurrency={currency}
            searchTerm={searchTerm}
            onSearchChange={setSearchTerm}
            searchPlaceholder="Search holdings by token name, symbol, or account..."
            hasActiveFilters={
              filterBy !== 'all' ||
              filterByAccount !== 'all' ||
              filterByToken !== 'all' ||
              valueRange !== 'all'
            }
            filters={[
              <TokenTypeSelector
                key="type"
                value={filterBy}
                onValueChange={(value) => updateFilter('type', value)}
                tokenTypes={tokenTypes.map((type) => ({
                  id: type.code,
                  code: type.code,
                  name: type.name,
                }))}
                placeholder="Filter by type..."
              />,
              <AccountFilterSelector
                key="account"
                value={filterByAccount}
                onValueChange={(value) => updateFilter('account', value)}
                accounts={accountOptions}
                institutions={institutionOptions}
                placeholder="Filter by account..."
              />,
              <TokenFilterSelector
                key="token"
                value={filterByToken}
                onValueChange={(value) => updateFilter('token', value)}
                tokens={tokenOptions}
                placeholder="Filter by token..."
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
              <div className="flex items-center gap-2 w-full">
                <Select value={valueRange} onValueChange={setValueRange}>
                  <SelectTrigger className="w-40">
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
                  <SelectTrigger className="w-40">
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

          {/* Holdings Display */}
          <Tabs value="holdings" className="w-full">
            <TabsContent value="holdings" className="space-y-6">
              {Object.entries(groupedHoldings).map(([groupName, holdings]) => (
                <div key={groupName}>
                  {groupBy !== 'none' && (
                    <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
                      <Filter className="h-5 w-5" />
                      {groupName} ({holdings.length} holdings • $
                      {holdings.reduce((sum, h) => sum + h.value, 0).toLocaleString()})
                    </h3>
                  )}

                  {viewMode === 'cards' ? (
                    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                      {holdings.map((holding) => (
                        <Card key={holding.id} className="hover:shadow-md transition-shadow">
                          <CardHeader>
                            <CardTitle className="flex items-center justify-between">
                              <span className="flex items-center gap-2">
                                {holding.token.symbol || holding.token.name}
                              </span>
                              <TokenTypeBadge tokenTypeCode={holding.token.typeCode} />
                            </CardTitle>
                            <div className="flex items-center gap-2">
                              <AccountBadge
                                accountId={holding.account.id}
                                accountName={holding.account.name}
                              />
                              <InstitutionBadge
                                institutionId={holding.institution.id}
                                institutionName={holding.institution.name}
                              />
                            </div>
                          </CardHeader>
                          <CardContent>
                            <div className="space-y-2">
                              <div className="text-2xl font-bold">
                                {holding.amount.toLocaleString()} {holding.token.symbol}
                              </div>
                              <div className="text-lg font-semibold">
                                $
                                {holding.value.toLocaleString(undefined, {
                                  minimumFractionDigits: 2,
                                  maximumFractionDigits: 2,
                                })}
                              </div>
                            </div>
                          </CardContent>
                        </Card>
                      ))}
                    </div>
                  ) : (
                    <Card>
                      <CardContent className="p-0">
                        <div className="overflow-x-auto">
                          <table className="w-full">
                            <thead className="border-b bg-muted/50">
                              <tr className="text-left">
                                <th
                                  className="p-4 font-medium cursor-pointer hover:bg-muted/70"
                                  onClick={() => handleSort('name')}
                                >
                                  <div className="flex items-center gap-2">
                                    Token
                                    <ArrowUpDown className="h-4 w-4" />
                                  </div>
                                </th>
                                <th
                                  className="p-4 font-medium cursor-pointer hover:bg-muted/70"
                                  onClick={() => handleSort('amount')}
                                >
                                  <div className="flex items-center gap-2">
                                    Amount
                                    <ArrowUpDown className="h-4 w-4" />
                                  </div>
                                </th>
                                <th
                                  className="p-4 font-medium cursor-pointer hover:bg-muted/70"
                                  onClick={() => handleSort('value')}
                                >
                                  <div className="flex items-center gap-2">
                                    Value
                                    <ArrowUpDown className="h-4 w-4" />
                                  </div>
                                </th>
                                <th
                                  className="p-4 font-medium cursor-pointer hover:bg-muted/70"
                                  onClick={() => handleSort('institution')}
                                >
                                  <div className="flex items-center gap-2">
                                    Institution
                                    <ArrowUpDown className="h-4 w-4" />
                                  </div>
                                </th>
                                <th className="p-4 font-medium">Account</th>
                                <th className="p-4 font-medium">Actions</th>
                              </tr>
                            </thead>
                            <tbody>
                              {holdings.map((holding) => (
                                <tr
                                  key={holding.id}
                                  className="border-b hover:bg-muted/50 transition-colors"
                                >
                                  <td className="p-4">
                                    <div>
                                      <div className="font-medium flex items-center gap-2">
                                        {holding.token.symbol}
                                      </div>
                                      <div className="text-sm text-muted-foreground">
                                        {holding.token.name}
                                      </div>
                                      <TokenTypeBadge tokenTypeCode={holding.token.typeCode} />
                                    </div>
                                  </td>
                                  <td className="p-4 font-mono">
                                    {holding.amount.toLocaleString()}
                                  </td>
                                  <td className="p-4 font-mono font-medium">
                                    <MoneyDisplay value={holding.value} token={baseCurrencyToken} />
                                  </td>
                                  <td className="p-4">
                                    <InstitutionBadge
                                      institutionId={holding.institution.id}
                                      institutionName={holding.institution.name}
                                    />
                                  </td>
                                  <td className="p-4">
                                    <AccountBadge
                                      accountId={holding.account.id}
                                      accountName={holding.account.name}
                                    />
                                  </td>
                                  <td className="p-4">
                                    <DropdownMenu>
                                      <DropdownMenuTrigger asChild>
                                        <Button variant="ghost" size="sm">
                                          <MoreHorizontal className="h-4 w-4" />
                                        </Button>
                                      </DropdownMenuTrigger>
                                      <DropdownMenuContent>
                                        <DropdownMenuItem>View Details</DropdownMenuItem>
                                        <DropdownMenuItem>View Transactions</DropdownMenuItem>
                                        <DropdownMenuItem className="text-red-600">
                                          <AlertTriangle className="h-4 w-4 mr-2" />
                                          Flag for Review
                                        </DropdownMenuItem>
                                      </DropdownMenuContent>
                                    </DropdownMenu>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </CardContent>
                    </Card>
                  )}
                </div>
              ))}

              {filteredAndSortedHoldings.length === 0 && (
                <Card>
                  <CardContent className="py-12 text-center">
                    <div className="text-muted-foreground">
                      <Filter className="h-12 w-12 mx-auto mb-4 opacity-50" />
                      <h3 className="text-lg font-medium mb-2">No holdings found</h3>
                      <p>Try adjusting your filters or search terms.</p>
                    </div>
                  </CardContent>
                </Card>
              )}
            </TabsContent>
          </Tabs>
        </>
      )}
    </div>
  );
}
