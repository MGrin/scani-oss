import {
  AlertTriangle,
  CreditCard,
  Filter,
  Grid3X3,
  List,
  MoreHorizontal,
  Trash2,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { InstitutionBadge } from '@/components/features';
import {
  AccountTypeSelector,
  InstitutionSelector,
} from '@/components/selectors/SearchableSelectors';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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

type Account = {
  id: string;
  userId: string;
  institutionId: string;
  name: string;
  typeId: string;
  description?: string | null;
  metadata?: unknown;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  summary: {
    holdingsCount: number;
    totalValue: string;
  };
};

type GroupBy = 'none' | 'institution' | 'type';

export function Accounts() {
  // Fetch accounts data from tRPC
  const { data: accountsData, isLoading, error } = trpc.accounts.getByUserIdWithSummary.useQuery();

  // Fetch account types and institutions for display
  const { data: accountTypes } = trpc.accountTypes.getAll.useQuery();
  const { data: institutions } = trpc.institutions.getByUserId.useQuery();

  // Fetch base currency for proper formatting
  const { data: baseCurrency } = trpc.users.getBaseCurrency.useQuery();
  const currency = baseCurrency?.symbol || 'USD';
  const baseCurrencyToken = createCurrencyToken(currency);

  const { toast } = useToast();
  const navigate = useNavigate();
  const utils = trpc.useUtils();

  // Delete account mutation with proper invalidation and optimistic updates
  const deleteAccountMutation = trpc.accounts.delete.useMutation({
    onMutate: async (removedAccount) => {
      // Snapshot previous value
      const previousAccounts = utils.accounts.getByUserIdWithSummary.getData();

      // Optimistically remove the account
      utils.accounts.getByUserIdWithSummary.setData(undefined, (old) =>
        old?.filter((account) => account.id !== removedAccount.id)
      );

      return { previousAccounts };
    },
    onSuccess: () => {
      toast({
        title: 'Account deleted',
        description: 'The account has been successfully deleted.',
      });

      // Navigate to accounts page
      navigate('/accounts');
    },
    onError: (err, _accountId, context) => {
      // Rollback on error
      if (context?.previousAccounts) {
        utils.accounts.getByUserIdWithSummary.setData(undefined, context.previousAccounts);
      }

      showError(err, 'Deleting account');
    },
    onSettled: () => {
      // Always refetch after error or success
      utils.accounts.getByUserIdWithSummary.invalidate();
    },
  });

  // Bulk delete accounts mutation
  const bulkDeleteAccountsMutation = trpc.accounts.bulkDelete.useMutation({
    onMutate: async (input) => {
      // Snapshot previous value
      const previousAccounts = utils.accounts.getByUserIdWithSummary.getData();

      // Optimistically remove the accounts
      utils.accounts.getByUserIdWithSummary.setData(undefined, (old) =>
        old?.filter((account) => !input.ids.includes(account.id))
      );

      return { previousAccounts };
    },
    onSuccess: (result) => {
      toast({
        title: result.failed > 0 ? 'Accounts partially deleted' : 'Accounts deleted',
        description:
          result.failed > 0
            ? `Successfully deleted ${result.deleted} of ${result.total} accounts. ${result.failed} failed.`
            : `Successfully deleted ${result.deleted} of ${result.total} accounts.`,
      });

      // Only clear successfully deleted items from selection
      if (result.failedIds && result.failedIds.length > 0) {
        setSelectedRows(new Set(result.failedIds));
      } else {
        setSelectedRows(new Set());
      }
    },
    onError: (err, _input, _context) => {
      // Don't rollback - let onSettled refetch instead
      // This ensures consistency with actual backend state
      showError(err, 'Deleting accounts');
    },
    onSettled: () => {
      // Always refetch after error or success
      utils.accounts.getByUserIdWithSummary.invalidate();
    },
  });

  // Transform backend data to match frontend expectations
  const accounts = accountsData || [];

  const [searchTerm, setSearchTerm] = useState('');
  const [groupBy, setGroupBy] = useState<GroupBy>('none');
  const [viewMode, setViewMode] = useViewMode('cards');
  const [sortField, setSortField] = useState('value');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('desc');
  const [valueRange, setValueRange] = useState('all');
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set());

  // Unified filter system
  const {
    filters: filterValues,
    updateFilter,
    clearAllFilters,
  } = useFilters([
    { key: 'type', defaultValue: '' },
    { key: 'institution', defaultValue: '' },
  ]);

  const filterByType = filterValues.type || '';
  const filterByInstitution = filterValues.institution || '';

  // Get unique values for filters
  const institutionMap = new Map();
  accounts.forEach((account) => {
    if (!institutionMap.has(account.institutionId)) {
      const institution = institutions?.find((inst) => inst.id === account.institutionId);
      if (institution) {
        institutionMap.set(account.institutionId, institution);
      }
    }
  });
  const uniqueInstitutions = Array.from(institutionMap.values());

  const accountTypeMap = new Map();
  accounts.forEach((account) => {
    if (!accountTypeMap.has(account.typeId)) {
      const accountType = accountTypes?.find((type) => type.id === account.typeId);
      if (accountType) {
        accountTypeMap.set(account.typeId, accountType);
      }
    }
  });

  // Prepare data for SearchableSelectors
  const institutionOptions = uniqueInstitutions.map((inst) => ({
    id: inst.id,
    name: inst.name,
    type: inst.type,
    typeCode: inst.typeCode,
    website: inst.website,
  }));

  // Filter and sort accounts
  const filteredAndSortedAccounts = useMemo(() => {
    const filtered = accounts.filter((account) => {
      const institution = institutions?.find((inst) => inst.id === account.institutionId);
      const accountType = accountTypes?.find((type) => type.id === account.typeId);

      const matchesSearch =
        searchTerm === '' ||
        account.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        institution?.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        accountType?.name.toLowerCase().includes(searchTerm.toLowerCase());

      const matchesTypeFilter = filterByType === '' || account.typeId === filterByType;
      const matchesInstitutionFilter =
        filterByInstitution === '' || account.institutionId === filterByInstitution;

      // Value range filter
      let matchesValueRange = true;
      if (valueRange !== 'all') {
        const value = parseFloat(account.summary.totalValue);
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

      return matchesSearch && matchesTypeFilter && matchesInstitutionFilter && matchesValueRange;
    });

    // Sort accounts
    filtered.sort((a, b) => {
      let aValue: number | string, bValue: number | string;

      switch (sortField) {
        case 'value':
          aValue = parseFloat(a.summary.totalValue);
          bValue = parseFloat(b.summary.totalValue);
          break;
        case 'name':
          aValue = a.name.toLowerCase();
          bValue = b.name.toLowerCase();
          break;
        case 'institution': {
          const aInst = institutions?.find((inst) => inst.id === a.institutionId)?.name || '';
          const bInst = institutions?.find((inst) => inst.id === b.institutionId)?.name || '';
          aValue = aInst.toLowerCase();
          bValue = bInst.toLowerCase();
          break;
        }
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
        : (bValue as number) - aValue;
    });

    return filtered;
  }, [
    accounts,
    searchTerm,
    filterByType,
    filterByInstitution,
    valueRange,
    sortField,
    sortDirection,
    institutions,
    accountTypes,
  ]);

  // Group accounts if needed
  const groupedAccounts =
    groupBy === 'none'
      ? { 'All Accounts': filteredAndSortedAccounts }
      : filteredAndSortedAccounts.reduce(
          (groups, account) => {
            let key = '';
            switch (groupBy) {
              case 'institution':
                key =
                  institutions?.find((inst) => inst.id === account.institutionId)?.name ||
                  'Unknown Institution';
                break;
              case 'type':
                key =
                  accountTypes?.find((type) => type.id === account.typeId)?.name || 'Unknown Type';
                break;
            }
            if (!groups[key]) groups[key] = [];
            groups[key]!.push(account);
            return groups;
          },
          {} as Record<string, typeof filteredAndSortedAccounts>
        );

  // Calculate summary statistics
  const summaryStats = useMemo(() => {
    const totalValue = filteredAndSortedAccounts.reduce(
      (sum, account) => sum + parseFloat(account.summary.totalValue),
      0
    );

    return {
      totalValue,
      accountCount: filteredAndSortedAccounts.length,
    };
  }, [filteredAndSortedAccounts]);

  const handleSort = (field: string) => {
    if (sortField === field) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('desc');
    }
  };

  const handleDeleteAccount = (account: Account) => {
    deleteAccountMutation.mutate({ id: account.id });
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
      const allIds = filteredAndSortedAccounts.map((account) => account.id);
      setSelectedRows(new Set(allIds));
    } else {
      setSelectedRows(new Set());
    }
  };

  const handleBulkDelete = () => {
    if (selectedRows.size === 0) return;

    const confirmed = window.confirm(
      `Are you sure you want to delete ${selectedRows.size} account${selectedRows.size !== 1 ? 's' : ''}?`
    );

    if (confirmed) {
      bulkDeleteAccountsMutation.mutate({ ids: Array.from(selectedRows) });
    }
  };

  const renderActions = (account: Account) => (
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
            handleDeleteAccount(account);
          }}
          className="text-destructive focus:text-destructive"
        >
          <Trash2 className="mr-2 h-4 w-4" />
          Remove Account
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const clearFilters = () => {
    setSearchTerm('');
    clearAllFilters();
    setValueRange('all');
    setSortField('value');
    setSortDirection('desc');
  };

  return (
    <div className="space-y-6">
      <PageHeader title="Accounts" subtitle="Manage all your financial accounts" />

      {isLoading ? (
        <div className="space-y-6 max-w-[calc(100vw-2rem)]">
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

          {/* Accounts cards skeletons */}
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
              <h3 className="text-lg font-medium mb-2">Error loading accounts</h3>
              <p>Unable to load your accounts data. Please try again later.</p>
            </div>
          </CardContent>
        </Card>
      ) : accounts.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <div className="text-muted-foreground">
              <CreditCard className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <h3 className="text-lg font-medium mb-2">No accounts found</h3>
              <p>
                You don't have any accounts yet. Connect your financial institutions to get started.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Page Aggregation with Search and Filters */}
          <PageAggregation
            totalCount={accounts.length}
            filteredCount={filteredAndSortedAccounts.length}
            entityLabel="accounts"
            totalBalance={summaryStats.totalValue}
            filteredBalance={summaryStats.totalValue}
            baseCurrency={currency}
            searchTerm={searchTerm}
            onSearchChange={setSearchTerm}
            searchPlaceholder="Search accounts by name, institution, or type..."
            hasActiveFilters={
              filterByType !== '' || filterByInstitution !== '' || valueRange !== 'all'
            }
            filters={[
              <AccountTypeSelector
                key="type"
                value={filterByType}
                onValueChange={(value) => updateFilter('type', value)}
                accountTypes={Array.from(accountTypeMap.values())}
                placeholder="Filter by type..."
              />,
              <InstitutionSelector
                key="institution"
                value={filterByInstitution}
                onValueChange={(value) => updateFilter('institution', value)}
                institutions={institutionOptions}
                placeholder="Filter by institution..."
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
                    <SelectItem value="type">By Type</SelectItem>
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

          {/* Accounts Display */}
          <Tabs value="accounts" className="w-full">
            <TabsContent value="accounts" className="space-y-6">
              {Object.entries(groupedAccounts).map(([groupName, accounts]) => (
                <div key={groupName}>
                  {groupBy !== 'none' && (
                    <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
                      <Filter className="h-5 w-5" />
                      {groupName} ({accounts.length} account
                      {accounts.length !== 1 ? 's' : ''})
                    </h3>
                  )}

                  {viewMode === 'cards' ? (
                    <div className="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
                      {accounts.map((account) => {
                        const institution = institutions?.find(
                          (inst) => inst.id === account.institutionId
                        );
                        const accountType = accountTypes?.find(
                          (type) => type.id === account.typeId
                        );

                        return (
                          <Card
                            key={account.id}
                            className="hover:shadow-md transition-shadow cursor-pointer"
                            onClick={() => navigate(`/accounts/${account.id}`)}
                          >
                            <CardHeader>
                              <CardTitle className="flex items-center justify-between">
                                <span className="flex items-center gap-2">{account.name}</span>
                                <div className="text-sm text-muted-foreground">
                                  {accountType?.name || 'Unknown'}
                                </div>
                              </CardTitle>
                              <div className="flex items-center gap-2">
                                <InstitutionBadge
                                  institutionId={account.institutionId}
                                  institutionName={institution?.name || 'Unknown Institution'}
                                  institutionWebsite={institution?.website || undefined}
                                />
                              </div>
                            </CardHeader>
                            <CardContent>
                              <div className="space-y-2">
                                <div className="text-2xl font-bold">
                                  <MoneyDisplay
                                    value={parseFloat(account.summary.totalValue)}
                                    token={baseCurrencyToken}
                                  />
                                </div>
                                <div className="text-sm text-muted-foreground">
                                  {account.summary.holdingsCount} holding
                                  {account.summary.holdingsCount !== 1 ? 's' : ''}
                                </div>
                              </div>
                            </CardContent>
                          </Card>
                        );
                      })}
                    </div>
                  ) : (
                    <>
                      {selectedRows.size > 0 && (
                        <Card className="mb-4">
                          <CardContent className="py-3">
                            <div className="flex items-center justify-between">
                              <span className="text-sm font-medium">
                                {selectedRows.size} account{selectedRows.size !== 1 ? 's' : ''}{' '}
                                selected
                              </span>
                              <Button
                                variant="destructive"
                                size="sm"
                                onClick={handleBulkDelete}
                                disabled={bulkDeleteAccountsMutation.isPending}
                              >
                                <Trash2 className="h-4 w-4 mr-2" />
                                Delete Selected
                              </Button>
                            </div>
                          </CardContent>
                        </Card>
                      )}
                      <DataTable
                        // @ts-expect-error TS2322 - Account type mismatch
                        data={accounts}
                        columns={[
                          {
                            header: 'Account',
                            accessor: (row) => (
                              <div>
                                <div className="font-medium">{row.name}</div>
                                <div className="text-sm text-muted-foreground">
                                  {accountTypes?.find((type) => type.id === row.typeId)?.name ||
                                    'Unknown Type'}
                                </div>
                              </div>
                            ),
                            sortable: true,
                          },
                          {
                            header: 'Institution',
                            accessor: (row) => (
                              <InstitutionBadge
                                institutionId={row.institutionId}
                                institutionName={
                                  institutions?.find((inst) => inst.id === row.institutionId)
                                    ?.name || 'Unknown'
                                }
                                institutionWebsite={
                                  institutions?.find((inst) => inst.id === row.institutionId)
                                    ?.website || undefined
                                }
                              />
                            ),
                            sortable: true,
                          },
                          {
                            header: 'Balance',
                            accessor: (row) => (
                              <MoneyDisplay
                                value={parseFloat(row.summary.totalValue)}
                                token={baseCurrencyToken}
                              />
                            ),
                            className: 'font-mono font-medium',
                            sortable: true,
                          },
                          {
                            header: 'Holdings',
                            accessor: (row) =>
                              `${row.summary.holdingsCount} holding${
                                row.summary.holdingsCount !== 1 ? 's' : ''
                              }`,
                            className: 'text-muted-foreground',
                          },
                        ]}
                        getRowKey={(row) => row.id}
                        onSort={handleSort}
                        onRowClick={(row) => navigate(`/accounts/${row.id}`)}
                        actions={renderActions}
                        selectable={true}
                        selectedRows={selectedRows}
                        onSelectRow={handleSelectRow}
                        onSelectAll={handleSelectAll}
                      />
                    </>
                  )}
                </div>
              ))}

              {filteredAndSortedAccounts.length === 0 && (
                <Card>
                  <CardContent className="py-12 text-center">
                    <div className="text-muted-foreground">
                      <Filter className="h-12 w-12 mx-auto mb-4 opacity-50" />
                      <h3 className="text-lg font-medium mb-2">No accounts found</h3>
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
