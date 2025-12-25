import type { HoldingWithDetails } from '@scani/shared';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  Edit,
  Filter,
  Grid3X3,
  List,
  MoreHorizontal,
  PieChart,
  Trash2,
  XCircle,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AccountBadge, InstitutionBadge, TokenTypeBadge } from '@/components/features';
import { BulkEditGroupsModal } from '@/components/modals/BulkEditGroupsModal';
import {
  AccountFilterSelector,
  TokenFilterSelector,
  TokenTypeSelector,
} from '@/components/selectors/SearchableSelectors';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Combobox } from '@/components/ui/combobox';
import { DataTable } from '@/components/ui/data-table';
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
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent } from '@/components/ui/tabs';
import { useFilters, useViewMode } from '@/hooks';
import { showError, useToast } from '@/hooks/use-toast';
import { trpc } from '@/lib/trpc';
import { createCurrencyToken } from '@/lib/utils';

type GroupBy = 'none' | 'institution' | 'account' | 'tokenType';

export function Holdings() {
  // Fetch holdings data from tRPC
  const { data: holdingsData, isLoading, error } = trpc.holdings.getWithDetails.useQuery();

  // Fetch groups for filtering
  const { data: groupsData } = trpc.groups.getAll.useQuery();
  const groups = groupsData || [];

  // Fetch base currency for proper formatting
  const { data: baseCurrency } = trpc.users.getBaseCurrency.useQuery();
  const currency = baseCurrency?.symbol || 'USD';
  const baseCurrencyToken = createCurrencyToken(currency);

  const { toast } = useToast();
  const navigate = useNavigate();
  const utils = trpc.useUtils();

  // Delete holding mutation
  const deleteHoldingMutation = trpc.holdings.delete.useMutation({
    onSuccess: () => {
      // Invalidate all holding-related queries
      utils.holdings.getWithDetails.invalidate();
      utils.accounts.getHoldings.invalidate();
      utils.accounts.getByUserIdWithSummary.invalidate();
      utils.dashboard.getOverview.invalidate();

      toast({
        title: 'Holding deleted',
        description: 'The holding has been successfully deleted.',
      });
    },
    onError: (error) => showError(error, 'Deleting holding'),
  });

  // Bulk delete holdings mutation
  const bulkDeleteHoldingsMutation = trpc.holdings.bulkDelete.useMutation({
    onSuccess: (result) => {
      // Invalidate all holding-related queries
      utils.holdings.getWithDetails.invalidate();
      utils.accounts.getHoldings.invalidate();
      utils.accounts.getByUserIdWithSummary.invalidate();
      utils.dashboard.getOverview.invalidate();

      toast({
        title: result.failed > 0 ? 'Holdings partially deleted' : 'Holdings deleted',
        description:
          result.failed > 0
            ? `Successfully deleted ${result.deleted} of ${result.total} holdings. ${result.failed} failed.`
            : `Successfully deleted ${result.deleted} of ${result.total} holdings.`,
      });

      // Only clear successfully deleted items from selection
      if (result.failedIds && result.failedIds.length > 0) {
        setSelectedRows(new Set(result.failedIds));
      } else {
        setSelectedRows(new Set());
      }
    },
    onError: (error) => showError(error, 'Deleting holdings'),
  });

  // Transform backend data to match frontend expectations
  const holdings = holdingsData || [];

  const [searchTerm, setSearchTerm] = useState('');
  const [groupBy, setGroupBy] = useState<GroupBy>('none');
  const [viewMode, setViewMode] = useViewMode('cards');
  const [sortField, setSortField] = useState('value');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const [valueRange, setValueRange] = useState('all');
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set());
  const [bulkEditGroupsModalOpen, setBulkEditGroupsModalOpen] = useState(false);

  // Unified filter system
  const {
    filters: filterValues,
    updateFilter,
    clearAllFilters,
  } = useFilters([
    { key: 'type', defaultValue: '' },
    { key: 'account', defaultValue: '' },
    { key: 'token', defaultValue: '' },
    { key: 'group', defaultValue: '' },
  ]);

  const filterBy = filterValues.type || '';
  const filterByAccount = filterValues.account || '';
  const filterByToken = filterValues.token || '';
  const filterByGroup = filterValues.group || '';

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
    typeCode: inst.typeCode,
    website: inst.website,
  }));

  const accountOptions = accounts.map((acc) => ({
    id: acc.id,
    name: acc.name,
    typeName: acc.type,
    institutionId: acc.institutionId,
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
    typeName: token.type,
    iconUrl: token.iconUrl,
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

      const matchesTypeFilter = filterBy === '' || holding.token.typeCode === filterBy;
      const matchesAccountFilter = filterByAccount === '' || holding.account.id === filterByAccount;
      const matchesTokenFilter = filterByToken === '' || holding.token.symbol === filterByToken;
      const matchesGroupFilter =
        filterByGroup === '' || holding.groups.some((g) => g.id === filterByGroup);

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
        matchesGroupFilter &&
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
    filterByGroup,
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

  // Calculate summary statistics (exclude inactive holdings from totals)
  const summaryStats = useMemo(() => {
    const activeHoldings = filteredAndSortedHoldings.filter((h) => h.isActive);
    const totalValue = activeHoldings.reduce((sum, h) => sum + h.value, 0);

    return {
      totalValue,
      holdingCount: activeHoldings.length,
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

  // Navigation handler
  const handleHoldingClick = (holding: HoldingWithDetails) => {
    navigate(`/holdings/${holding.id}`);
  };

  const handleDeleteHolding = (holding: HoldingWithDetails) => {
    deleteHoldingMutation.mutate({ id: holding.id });
  };

  // Update holding mutation for toggling isActive
  const updateHoldingMutation = trpc.holdings.update.useMutation({
    onSuccess: () => {
      // Invalidate all holding-related queries
      utils.holdings.getWithDetails.invalidate();
      utils.accounts.getHoldings.invalidate();
      utils.accounts.getByUserIdWithSummary.invalidate();
      utils.dashboard.getOverview.invalidate();

      toast({
        title: 'Holding updated',
        description: 'The holding status has been successfully updated.',
      });
    },
    onError: (error) => showError(error, 'Updating holding'),
  });

  const handleToggleActive = (holding: HoldingWithDetails) => {
    updateHoldingMutation.mutate({
      id: holding.id,
      data: { isActive: !holding.isActive },
    });
  };

  const handleSelectRow = (rowKey: string) => {
    setSelectedRows((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(rowKey)) {
        newSet.delete(rowKey);
      } else {
        newSet.add(rowKey);
      }
      return newSet;
    });
  };

  const handleSelectAll = (selected: boolean) => {
    if (selected) {
      const allIds = filteredAndSortedHoldings.map((holding) => holding.id);
      setSelectedRows(new Set(allIds));
    } else {
      setSelectedRows(new Set());
    }
  };

  const handleBulkDelete = () => {
    if (selectedRows.size === 0) return;

    const confirmed = window.confirm(
      `Are you sure you want to delete ${selectedRows.size} holding${
        selectedRows.size !== 1 ? 's' : ''
      }?`
    );

    if (confirmed) {
      bulkDeleteHoldingsMutation.mutate({ ids: Array.from(selectedRows) });
    }
  };

  const renderActions = (holding: HoldingWithDetails) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="h-8 w-8 p-0">
          <span className="sr-only">Open menu</span>
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          onClick={(e) => {
            e.stopPropagation();
            handleToggleActive(holding);
          }}
        >
          {holding.isActive ? (
            <>
              <XCircle className="mr-2 h-4 w-4" />
              Mark as Inactive
            </>
          ) : (
            <>
              <CheckCircle2 className="mr-2 h-4 w-4" />
              Mark as Active
            </>
          )}
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={(e) => {
            e.stopPropagation();
            handleDeleteHolding(holding);
          }}
          className="text-destructive focus:text-destructive"
        >
          <Trash2 className="mr-2 h-4 w-4" />
          Remove Holding
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

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
        <div className="space-y-6">
          {/* Summary cards skeletons */}
          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader>
                <Skeleton className="h-5 w-32" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-8 w-24 mb-2" />
                <Skeleton className="h-4 w-16" />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <Skeleton className="h-5 w-28" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-8 w-20 mb-2" />
                <Skeleton className="h-4 w-12" />
              </CardContent>
            </Card>
          </div>

          {/* Filters card skeleton */}
          <Card className="min-h-[200px]">
            <CardHeader>
              <Skeleton className="h-6 w-48" />
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <div className="flex gap-4">
                  <Skeleton className="h-10 w-48" />
                  <Skeleton className="h-10 w-40" />
                  <Skeleton className="h-10 w-44" />
                </div>
                <div className="flex gap-4">
                  <Skeleton className="h-10 w-40" />
                  <Skeleton className="h-10 w-40" />
                  <Skeleton className="h-10 w-32 ml-auto" />
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Holdings cards skeletons */}
          <div className="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
            {[1, 2, 3, 4].map((num) => (
              <Card key={`skeleton-${num}`}>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Skeleton className="h-6 w-6 rounded-full" />
                      <Skeleton className="h-4 w-24" />
                    </div>
                    <Skeleton className="h-5 w-16" />
                  </div>
                  <div className="flex items-center gap-2">
                    <Skeleton className="h-4 w-4" />
                    <Skeleton className="h-4 w-20" />
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    <Skeleton className="h-8 w-32" />
                    <Skeleton className="h-6 w-24" />
                  </div>
                </CardContent>
              </Card>
            ))}
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

          {/* Holdings Display */}
          <Tabs value="holdings" className="w-full">
            <TabsContent value="holdings" className="space-y-6">
              {Object.entries(groupedHoldings).map(([groupName, holdings]) => {
                const activeHoldings = holdings.filter((h) => h.isActive);
                const groupValue = activeHoldings.reduce((sum, h) => sum + h.value, 0);
                return (
                  <div key={groupName}>
                    {groupBy !== 'none' && (
                      <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
                        <Filter className="h-5 w-5" />
                        {groupName} ({activeHoldings.length} holdings •{' '}
                        <MoneyDisplay
                          value={groupValue}
                          token={baseCurrencyToken}
                          minimumFractionDigits={0}
                          maximumFractionDigits={0}
                        />
                        )
                      </h3>
                    )}

                    {viewMode === 'cards' ? (
                      <>
                        {selectedRows.size > 0 && (
                          <Card className="mb-4">
                            <CardContent className="py-3">
                              <div className="flex items-center justify-between">
                                <span className="text-sm font-medium">
                                  {selectedRows.size} holding
                                  {selectedRows.size !== 1 ? 's' : ''} selected
                                </span>
                                <div className="flex items-center gap-2">
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => setBulkEditGroupsModalOpen(true)}
                                  >
                                    <Edit className="h-4 w-4 mr-2" />
                                    Edit Selected
                                  </Button>
                                  <Button
                                    variant="destructive"
                                    size="sm"
                                    onClick={handleBulkDelete}
                                    disabled={bulkDeleteHoldingsMutation.isPending}
                                  >
                                    <Trash2 className="h-4 w-4 mr-2" />
                                    Delete Selected
                                  </Button>
                                </div>
                              </div>
                            </CardContent>
                          </Card>
                        )}
                        <div className="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
                          {holdings.map((holding) => {
                            const isSelected = selectedRows.has(holding.id);
                            return (
                              <Card
                                key={holding.id}
                                className={`hover:shadow-md transition-shadow ${
                                  isSelected ? 'ring-2 ring-primary' : ''
                                }`}
                              >
                                <CardHeader>
                                  <CardTitle className="flex items-center justify-between">
                                    <span className="flex items-center gap-2">
                                      <div className="min-w-[44px] min-h-[44px] flex items-center justify-center">
                                        <Checkbox
                                          checked={isSelected}
                                          onCheckedChange={() => handleSelectRow(holding.id)}
                                          onClick={(e) => e.stopPropagation()}
                                          aria-label={`Select ${holding.token.symbol}`}
                                        />
                                      </div>
                                      <button
                                        type="button"
                                        className="cursor-pointer text-left font-semibold hover:underline"
                                        onClick={() => handleHoldingClick(holding)}
                                      >
                                        {holding.token.symbol || holding.token.name}
                                      </button>
                                    </span>
                                    <TokenTypeBadge tokenTypeCode={holding.token.typeCode} />
                                  </CardTitle>
                                  <div className="flex items-center gap-2">
                                    <AccountBadge
                                      accountId={holding.account.id}
                                      accountName={holding.account.name}
                                      accountTypeCode={holding.account.typeCode}
                                    />
                                    <InstitutionBadge
                                      institutionId={holding.institution.id}
                                      institutionName={holding.institution.name}
                                      institutionWebsite={holding.institution.website ?? undefined}
                                    />
                                  </div>
                                </CardHeader>
                                <CardContent
                                  className="cursor-pointer"
                                  onClick={() => handleHoldingClick(holding)}
                                >
                                  <div className="space-y-2">
                                    <div className="text-2xl font-bold">
                                      {holding.amount.toString()} {holding.token.symbol}
                                    </div>
                                    <div className="text-lg font-semibold">
                                      <MoneyDisplay
                                        value={holding.value}
                                        token={baseCurrencyToken}
                                      />
                                    </div>
                                  </div>
                                </CardContent>
                              </Card>
                            );
                          })}
                        </div>
                      </>
                    ) : (
                      <>
                        {selectedRows.size > 0 && (
                          <Card className="mb-4">
                            <CardContent className="py-3">
                              <div className="flex items-center justify-between">
                                <span className="text-sm font-medium">
                                  {selectedRows.size} holding
                                  {selectedRows.size !== 1 ? 's' : ''} selected
                                </span>
                                <div className="flex items-center gap-2">
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => setBulkEditGroupsModalOpen(true)}
                                  >
                                    <Edit className="h-4 w-4 mr-2" />
                                    Edit Selected
                                  </Button>
                                  <Button
                                    variant="destructive"
                                    size="sm"
                                    onClick={handleBulkDelete}
                                    disabled={bulkDeleteHoldingsMutation.isPending}
                                  >
                                    <Trash2 className="h-4 w-4 mr-2" />
                                    Delete Selected
                                  </Button>
                                </div>
                              </div>
                            </CardContent>
                          </Card>
                        )}
                        <DataTable
                          data={holdings}
                          columns={[
                            {
                              header: 'Token',
                              accessor: (row) => (
                                <div>
                                  <div className="font-medium flex items-center gap-2">
                                    {row.token.symbol}
                                  </div>
                                  <div className="text-sm text-muted-foreground">
                                    {row.token.name}
                                  </div>
                                  <TokenTypeBadge tokenTypeCode={row.token.typeCode} />
                                </div>
                              ),
                              sortable: true,
                            },
                            {
                              header: 'Amount',
                              accessor: (row) => {
                                return row.amount;
                              },
                              className: 'font-mono',
                              sortable: true,
                            },
                            {
                              header: 'Value',
                              accessor: (row) => (
                                <MoneyDisplay value={row.value} token={baseCurrencyToken} />
                              ),
                              className: 'font-mono font-medium',
                              sortable: true,
                            },
                            {
                              header: 'Institution',
                              accessor: (row) => (
                                <InstitutionBadge
                                  institutionId={row.institution.id}
                                  institutionName={row.institution.name}
                                  institutionWebsite={row.institution.website ?? undefined}
                                />
                              ),
                              sortable: true,
                            },
                            {
                              header: 'Account',
                              accessor: (row) => (
                                <AccountBadge
                                  accountId={row.account.id}
                                  accountName={row.account.name}
                                  accountTypeCode={row.account.typeCode}
                                />
                              ),
                            },
                            {
                              header: 'Status',
                              accessor: (row) => (
                                <span
                                  className={`text-xs px-2 py-1 rounded-full ${
                                    row.isActive
                                      ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400'
                                      : 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-400'
                                  }`}
                                >
                                  {row.isActive ? 'Active' : 'Inactive'}
                                </span>
                              ),
                              sortable: false,
                            },
                          ]}
                          getRowKey={(row) => row.id}
                          onSort={handleSort}
                          onRowClick={(row) => handleHoldingClick(row)}
                          actions={renderActions}
                          selectable={true}
                          selectedRows={selectedRows}
                          onSelectRow={handleSelectRow}
                          onSelectAll={handleSelectAll}
                        />
                      </>
                    )}
                  </div>
                );
              })}

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

      <BulkEditGroupsModal
        open={bulkEditGroupsModalOpen}
        onOpenChange={setBulkEditGroupsModalOpen}
        entityType="holding"
        selectedEntityIds={Array.from(selectedRows)}
        onSuccess={() => {
          utils.holdings.getWithDetails.invalidate();
          setSelectedRows(new Set());
          toast({
            title: 'Groups updated',
            description: 'Holding groups have been updated successfully.',
          });
        }}
      />
    </div>
  );
}
