import { AlertTriangle, CreditCard, Filter } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AccountCardGrid } from '@/components/accounts/AccountCardGrid';
import { AccountsLoadingSkeleton } from '@/components/accounts/AccountsLoadingSkeleton';
import { AccountsToolbar } from '@/components/accounts/AccountsToolbar';
import { AccountTableView } from '@/components/accounts/AccountTableRow';
import { BulkEditGroupsModal } from '@/components/modals/BulkEditGroupsModal';
import { Card, CardContent } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { Tabs, TabsContent } from '@/components/ui/tabs';
import { useFilters, useViewMode } from '@/hooks';
import { showError, useToast } from '@/hooks/use-toast';
import { type AccountForFilters, useAccountFilters } from '@/hooks/useAccountFilters';
import { trpc } from '@/lib/trpc';
import { createCurrencyToken } from '@/lib/utils';

type GroupBy = 'none' | 'institution' | 'type';

export function Accounts() {
  // Fetch accounts data from tRPC
  const { data: accountsData, isLoading, error } = trpc.accounts.getByUserIdWithSummary.useQuery();

  // Fetch account types and institutions for display
  const { data: accountTypes } = trpc.accountTypes.getAll.useQuery();
  const { data: institutions } = trpc.institutions.getByUserId.useQuery();
  const { data: groupsData } = trpc.groups.getAll.useQuery();

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
      const previousAccounts = utils.accounts.getByUserIdWithSummary.getData();
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
      navigate('/accounts');
    },
    onError: (err, _accountId, context) => {
      if (context?.previousAccounts) {
        utils.accounts.getByUserIdWithSummary.setData(undefined, context.previousAccounts);
      }
      showError(err, 'Deleting account');
    },
    onSettled: () => {
      utils.accounts.getByUserIdWithSummary.invalidate();
    },
  });

  // Bulk delete accounts mutation
  const bulkDeleteAccountsMutation = trpc.accounts.bulkDelete.useMutation({
    onMutate: async (input) => {
      const previousAccounts = utils.accounts.getByUserIdWithSummary.getData();
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
      if (result.failedIds && result.failedIds.length > 0) {
        setSelectedRows(new Set(result.failedIds));
      } else {
        setSelectedRows(new Set());
      }
    },
    onError: (err, _input, _context) => {
      showError(err, 'Deleting accounts');
    },
    onSettled: () => {
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
  const [bulkEditGroupsModalOpen, setBulkEditGroupsModalOpen] = useState(false);

  // Unified filter system
  const {
    filters: filterValues,
    updateFilter,
    clearAllFilters,
  } = useFilters([
    { key: 'type', defaultValue: '' },
    { key: 'institution', defaultValue: '' },
    { key: 'group', defaultValue: '' },
  ]);

  const filterByType = filterValues.type || '';
  const filterByInstitution = filterValues.institution || '';
  const filterByGroup = filterValues.group || '';

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

  // Use extracted filter/sort/group hook
  const { filteredAndSortedAccounts, groupedAccounts, summaryStats } = useAccountFilters({
    accounts: accounts as unknown as AccountForFilters[],
    searchTerm,
    filterByType,
    filterByInstitution,
    filterByGroup,
    valueRange,
    sortField,
    sortDirection,
    groupBy,
    institutions,
    accountTypes,
  });

  const handleSort = (field: string) => {
    if (sortField === field) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('desc');
    }
  };

  const handleDeleteAccount = (account: { id: string }) => {
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
      `Are you sure you want to delete ${selectedRows.size} account${
        selectedRows.size !== 1 ? 's' : ''
      }?`
    );

    if (confirmed) {
      bulkDeleteAccountsMutation.mutate({ ids: Array.from(selectedRows) });
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
      <PageHeader title="Accounts" subtitle="Manage all your financial accounts" />

      {isLoading ? (
        <AccountsLoadingSkeleton />
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
          <AccountsToolbar
            totalCount={accounts.length}
            filteredCount={filteredAndSortedAccounts.length}
            summaryTotalValue={summaryStats.totalValue}
            baseCurrency={currency}
            searchTerm={searchTerm}
            onSearchChange={setSearchTerm}
            filterByType={filterByType}
            filterByInstitution={filterByInstitution}
            filterByGroup={filterByGroup}
            onFilterChange={updateFilter}
            accountTypeOptions={Array.from(accountTypeMap.values())}
            institutionOptions={institutionOptions}
            groupOptions={
              groupsData?.map((group) => ({
                value: group.id,
                label: group.name,
              })) || []
            }
            valueRange={valueRange}
            onValueRangeChange={setValueRange}
            groupBy={groupBy}
            onGroupByChange={setGroupBy}
            viewMode={viewMode}
            onViewModeChange={setViewMode}
            onClearFilters={clearFilters}
          />

          {/* Accounts Display */}
          <Tabs value="accounts" className="w-full">
            <TabsContent value="accounts" className="space-y-6">
              {Object.entries(groupedAccounts).map(([groupName, groupAccounts]) => (
                <div key={groupName}>
                  {groupBy !== 'none' && (
                    <h3 className="text-lg font-semibold mb-4 flex items-center gap-2">
                      <Filter className="h-5 w-5" />
                      {groupName} ({groupAccounts.length} account
                      {groupAccounts.length !== 1 ? 's' : ''})
                    </h3>
                  )}

                  {viewMode === 'cards' ? (
                    <AccountCardGrid
                      accounts={groupAccounts}
                      institutions={institutions}
                      accountTypes={accountTypes}
                      baseCurrencyToken={baseCurrencyToken}
                      selectedRows={selectedRows}
                      bulkDeletePending={bulkDeleteAccountsMutation.isPending}
                      onSelectRow={handleSelectRow}
                      onNavigate={(id) => navigate(`/accounts/${id}`)}
                      onBulkEditGroups={() => setBulkEditGroupsModalOpen(true)}
                      onBulkDelete={handleBulkDelete}
                    />
                  ) : (
                    <AccountTableView
                      accounts={groupAccounts}
                      institutions={institutions}
                      accountTypes={accountTypes}
                      baseCurrencyToken={baseCurrencyToken}
                      selectedRows={selectedRows}
                      bulkDeletePending={bulkDeleteAccountsMutation.isPending}
                      onSort={handleSort}
                      onRowClick={(id) => navigate(`/accounts/${id}`)}
                      onSelectRow={handleSelectRow}
                      onSelectAll={handleSelectAll}
                      onDeleteAccount={handleDeleteAccount}
                      onBulkEditGroups={() => setBulkEditGroupsModalOpen(true)}
                      onBulkDelete={handleBulkDelete}
                    />
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

      <BulkEditGroupsModal
        open={bulkEditGroupsModalOpen}
        onOpenChange={setBulkEditGroupsModalOpen}
        entityType="account"
        selectedEntityIds={Array.from(selectedRows)}
        onSuccess={() => {
          utils.accounts.getByUserIdWithSummary.invalidate();
          setSelectedRows(new Set());
          toast({
            title: 'Groups updated',
            description: 'Account groups have been updated successfully.',
          });
        }}
      />
    </div>
  );
}
