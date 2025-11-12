import type { HoldingWithDetails } from '@scani/shared';
import { Edit, Grid3X3, List, MoreHorizontal, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import TimeAgo from 'react-timeago';
import { EditAccountModal, HoldingModal, TokenTypeBadge } from '@/components/features';
import { TokenFilterSelector, TokenTypeSelector } from '@/components/selectors/SearchableSelectors';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
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
import { showError, useToast } from '@/hooks/use-toast';
import { useViewMode } from '@/hooks/use-view-mode';
import { trpc } from '@/lib/trpc';
import { createCurrencyToken } from '@/lib/utils';

export function AccountDetail() {
  const { id } = useParams<{ id: string }>();

  // Sorting state
  const [sortField, setSortField] = useState('value');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');

  // Filtering and view state
  const [searchTerm, setSearchTerm] = useState('');
  const [filterBy, setFilterBy] = useState(''); // Token type filter
  const [filterByToken, setFilterByToken] = useState(''); // Token filter
  const [valueRange, setValueRange] = useState('all');
  const [viewMode, setViewMode] = useViewMode('table');

  // Modal state
  const [selectedHolding, setSelectedHolding] = useState<HoldingWithDetails | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isEditAccountModalOpen, setIsEditAccountModalOpen] = useState(false);

  // Selection state for bulk operations
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set());

  // Fetch base currency
  const { data: baseCurrency } = trpc.users.getBaseCurrency.useQuery();
  const currency = baseCurrency?.symbol || 'USD';
  const baseCurrencyToken = createCurrencyToken(currency);

  const { toast } = useToast();
  const utils = trpc.useUtils();

  // Delete holding mutation
  const deleteHoldingMutation = trpc.holdings.delete.useMutation({
    onSuccess: () => {
      // Invalidate all holding-related queries
      utils.holdings.getWithDetails.invalidate();
      utils.accounts.getHoldings.invalidate();
      utils.accounts.getById.invalidate();
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
      utils.accounts.getById.invalidate();
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

  // Fetch account data
  const {
    data: account,
    isLoading: accountLoading,
    error: accountError,
  } = trpc.accounts.getById.useQuery({ id: id! }, { enabled: !!id });

  // Fetch holdings for this account
  const { data: accountHoldings } = trpc.accounts.getHoldings.useQuery(
    { id: id! },
    { enabled: !!id }
  );

  // Filter and sort holdings
  const filteredAndSortedHoldings = useMemo(() => {
    if (!accountHoldings) return [];

    const filtered = accountHoldings.filter((holding) => {
      const matchesSearch =
        searchTerm === '' ||
        holding.token.symbol.toLowerCase().includes(searchTerm.toLowerCase()) ||
        holding.token.name.toLowerCase().includes(searchTerm.toLowerCase());

      const matchesType = filterBy === '' || holding.token.typeCode === filterBy;

      const matchesToken = filterByToken === '' || holding.token.symbol === filterByToken;

      const matchesValueRange = (() => {
        const value = holding.value;
        switch (valueRange) {
          case 'under-1k':
            return value < 1000;
          case '1k-10k':
            return value >= 1000 && value < 10000;
          case '10k-100k':
            return value >= 10000 && value < 100000;
          case 'over-100k':
            return value >= 100000;
          default:
            return true;
        }
      })();

      return matchesSearch && matchesType && matchesToken && matchesValueRange;
    });

    // Sort filtered holdings
    return filtered.sort((a, b) => {
      let aValue: number | string, bValue: number | string;

      switch (sortField) {
        case 'token':
          aValue = a.token.name.toLowerCase();
          bValue = b.token.name.toLowerCase();
          break;
        case 'amount':
          aValue = a.amount;
          bValue = b.amount;
          break;
        case 'price':
          aValue = a.price ? parseFloat(a.price.value) : 0;
          bValue = b.price ? parseFloat(b.price.value) : 0;
          break;
        default:
          aValue = a.value;
          bValue = b.value;
          break;
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
  }, [accountHoldings, searchTerm, filterBy, filterByToken, valueRange, sortField, sortDirection]);

  // Get unique values for filters
  const filterData = useMemo(() => {
    if (!accountHoldings) return { tokenTypes: [], tokens: [] };

    // Deduplicate token types by code
    const tokenTypeMap = new Map();
    accountHoldings.forEach((h) => {
      if (!tokenTypeMap.has(h.token.typeCode)) {
        tokenTypeMap.set(h.token.typeCode, {
          code: h.token.typeCode,
          name: h.token.type,
        });
      }
    });
    const tokenTypes = Array.from(tokenTypeMap.values());

    // Deduplicate tokens by symbol
    const tokenMap = new Map();
    accountHoldings.forEach((h) => {
      if (!tokenMap.has(h.token.symbol)) {
        tokenMap.set(h.token.symbol, h.token);
      }
    });
    const tokens = Array.from(tokenMap.values()).map((token) => ({
      id: token.symbol,
      symbol: token.symbol,
      name: token.name,
      type: token.typeCode,
      typeName: token.type,
      iconUrl: token.iconUrl,
    }));

    return { tokenTypes, tokens };
  }, [accountHoldings]);

  // Fetch account types and institutions for display
  const { data: accountTypes } = trpc.accountTypes.getAll.useQuery();

  const accountType = accountTypes?.find((type) => type.id === account?.typeId);

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
    setFilterBy('');
    setFilterByToken('');
    setValueRange('all');
    setSortField('value');
    setSortDirection('desc');
  };

  // Modal handlers
  const handleHoldingClick = (holding: HoldingWithDetails) => {
    setSelectedHolding(holding);
    setIsModalOpen(true);
  };

  const handleModalClose = () => {
    setIsModalOpen(false);
    setSelectedHolding(null);
  };

  const handleEditAccountModalClose = () => {
    setIsEditAccountModalOpen(false);
  };

  const handleAccountUpdated = () => {
    // Refetch account data
    // The TRPC query will automatically refetch when the modal updates
  };

  const handleHoldingUpdated = () => {
    // Refetch account holdings data
    // The TRPC query will automatically refetch when the modal updates
  };

  const handleHoldingDeleted = () => {
    // Refetch account holdings data
    // The TRPC query will automatically refetch when the modal deletes
  };

  const handleDeleteHolding = (holding: HoldingWithDetails) => {
    deleteHoldingMutation.mutate({ id: holding.id });
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
      `Are you sure you want to delete ${selectedRows.size} holding${selectedRows.size !== 1 ? 's' : ''}?`
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

  if (accountLoading) {
    return (
      <div className="space-y-6">
        <PageHeader title="" loading={true} />

        {/* Skeleton summary cards */}
        <div className="grid gap-4 grid-cols-1 md:grid-cols-3 max-w-[calc(100vw-2rem)]">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <Skeleton className="h-4 w-24" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-8 w-20 mb-2" />
              <Skeleton className="h-3 w-12" />
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <Skeleton className="h-4 w-20" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-8 w-16 mb-2" />
              <Skeleton className="h-3 w-16" />
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <Skeleton className="h-4 w-28" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-8 w-16 mb-2" />
              <Skeleton className="h-3 w-20" />
            </CardContent>
          </Card>
        </div>

        {/* Skeleton holdings table */}
        <Card className="max-w-[calc(100vw-2rem)]">
          <CardHeader>
            <Skeleton className="h-6 w-32" />
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="border-b bg-muted/50">
                  <tr className="text-left">
                    <th className="p-4">
                      <Skeleton className="h-4 w-12" />
                    </th>
                    <th className="p-4">
                      <Skeleton className="h-4 w-12" />
                    </th>
                    <th className="p-4">
                      <Skeleton className="h-4 w-12" />
                    </th>
                    <th className="p-4">
                      <Skeleton className="h-4 w-12" />
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {[1, 2, 3, 4].map((num) => (
                    <tr key={num} className="border-b">
                      <td className="p-4">
                        <div className="space-y-2">
                          <Skeleton className="h-4 w-16" />
                          <Skeleton className="h-3 w-24" />
                          <Skeleton className="h-4 w-12" />
                        </div>
                      </td>
                      <td className="p-4">
                        <Skeleton className="h-4 w-16" />
                      </td>
                      <td className="p-4">
                        <div className="space-y-1">
                          <Skeleton className="h-4 w-20" />
                          <Skeleton className="h-3 w-24" />
                        </div>
                      </td>
                      <td className="p-4">
                        <Skeleton className="h-4 w-20" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (accountError || !account) {
    return (
      <div className="space-y-6">
        <PageHeader title="Account Not Found" subtitle="The requested account could not be found" />
      </div>
    );
  }

  const totalValue = (filteredAndSortedHoldings || []).reduce(
    (sum: number, holding) => sum + holding.value,
    0
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title={account.name}
        subtitle={`Account • ${accountType?.name || 'Unknown Type'}`}
        secondaryActions={
          <Button onClick={() => setIsEditAccountModalOpen(true)} variant="outline">
            <Edit className="h-4 w-4 mr-2" />
            Edit Account
          </Button>
        }
      />

      {/* Holdings */}
      <PageAggregation
        totalCount={(accountHoldings || []).length}
        filteredCount={filteredAndSortedHoldings.length}
        entityLabel="holdings"
        totalBalance={totalValue}
        filteredBalance={totalValue}
        baseCurrency={currency}
        searchTerm={searchTerm}
        onSearchChange={setSearchTerm}
        searchPlaceholder="Search holdings by token name, symbol..."
        hasActiveFilters={filterBy !== '' || filterByToken !== '' || valueRange !== 'all'}
        filters={[
          <TokenTypeSelector
            key="type"
            value={filterBy}
            onValueChange={setFilterBy}
            tokenTypes={filterData.tokenTypes.map((type) => ({
              id: type.code,
              code: type.code,
              name: type.name,
            }))}
            placeholder="Filter by type..."
          />,
          <TokenFilterSelector
            key="token"
            value={filterByToken}
            onValueChange={setFilterByToken}
            tokens={filterData.tokens}
            placeholder="Filter by token..."
            includeAllOption={false}
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

            <div className="ml-auto mr-0">
              <Button
                variant="outline"
                size="sm"
                onClick={clearFilters}
                disabled={
                  searchTerm === '' &&
                  filterBy === '' &&
                  filterByToken === '' &&
                  valueRange === 'all'
                }
              >
                Clear Filters
              </Button>
            </div>
          </div>
        }
      />

      {/* Holdings Display */}
      {viewMode === 'table' ? (
        <>
          {selectedRows.size > 0 && (
            <Card className="mb-4">
              <CardContent className="py-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">
                    {selectedRows.size} holding{selectedRows.size !== 1 ? 's' : ''} selected
                  </span>
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
              </CardContent>
            </Card>
          )}
          <DataTable
            data={filteredAndSortedHoldings}
            columns={[
              {
                header: 'Token',
                accessor: (row: HoldingWithDetails) => (
                  <div>
                    <div className="font-medium flex items-center gap-2">{row.token.symbol}</div>
                    <div className="text-sm text-muted-foreground">{row.token.name}</div>
                    <TokenTypeBadge tokenTypeCode={row.token.typeCode} />
                  </div>
                ),
                sortable: true,
              },
              {
                header: 'Amount',
                accessor: (row: HoldingWithDetails) => (
                  <span className="font-mono">{row.amount.toString()}</span>
                ),
                className: 'font-mono',
                sortable: true,
              },
              {
                header: 'Price',
                accessor: (row: HoldingWithDetails) =>
                  row.price ? (
                    <div>
                      <MoneyDisplay value={parseFloat(row.price.value)} token={baseCurrencyToken} />
                      <div className="text-xs text-muted-foreground">
                        <TimeAgo date={new Date(row.price.timestamp)} />
                        {row.price.source && ` • ${row.price.source}`}
                      </div>
                    </div>
                  ) : (
                    <span className="text-muted-foreground">-</span>
                  ),
                className: 'font-mono',
                sortable: true,
              },
              {
                header: 'Value',
                accessor: (row: HoldingWithDetails) => (
                  <MoneyDisplay value={row.value} token={baseCurrencyToken} />
                ),
                className: 'font-mono font-medium',
                sortable: true,
              },
            ]}
            getRowKey={(row: HoldingWithDetails) => row.id}
            emptyMessage="No holdings match your filters."
            onSort={handleSort}
            sortField={sortField}
            sortDirection={sortDirection}
            onRowClick={(row) => handleHoldingClick(row)}
            actions={renderActions}
            selectable={true}
            selectedRows={selectedRows}
            onSelectRow={handleSelectRow}
            onSelectAll={handleSelectAll}
          />
        </>
      ) : (
        <div className="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
          {filteredAndSortedHoldings.map((holding) => (
            <Card
              key={holding.id}
              className="hover:shadow-md transition-shadow cursor-pointer"
              onClick={() => handleHoldingClick(holding)}
            >
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="font-medium">{holding.token.symbol}</div>
                    <TokenTypeBadge tokenTypeCode={holding.token.typeCode} />
                  </div>
                </div>
                <div className="text-sm text-muted-foreground">{holding.token.name}</div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex justify-between items-center">
                  <span className="text-sm text-muted-foreground">Amount</span>
                  <span className="font-mono font-medium">{holding.amount.toLocaleString()}</span>
                </div>

                {holding.price && (
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-muted-foreground">Price</span>
                    <div className="text-right">
                      <MoneyDisplay
                        value={parseFloat(holding.price.value)}
                        token={baseCurrencyToken}
                      />
                      <div className="text-xs text-muted-foreground">
                        <TimeAgo date={new Date(holding.price.timestamp)} />
                        {holding.price.source && ` • ${holding.price.source}`}
                      </div>
                    </div>
                  </div>
                )}

                <div className="flex justify-between items-center pt-2 border-t">
                  <span className="text-sm font-medium">Value</span>
                  <MoneyDisplay
                    value={holding.value}
                    token={baseCurrencyToken}
                    className="font-medium"
                  />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Holding Modal */}
      <HoldingModal
        holding={selectedHolding}
        isOpen={isModalOpen}
        onClose={handleModalClose}
        onHoldingUpdated={handleHoldingUpdated}
        onHoldingDeleted={handleHoldingDeleted}
      />

      {/* Edit Account Modal */}
      <EditAccountModal
        account={account}
        isOpen={isEditAccountModalOpen}
        onClose={handleEditAccountModalClose}
        onAccountUpdated={handleAccountUpdated}
      />
    </div>
  );
}
