import type { Account } from '@scani/shared';
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AccountRow } from '@/components/AccountRow';

import {
  AccountTypeSelector,
  InstitutionFilterSelector,
} from '@/components/selectors/SearchableSelectors';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { AccountsEmptyState, NoResultsEmptyState } from '@/components/ui/empty-state';
import { PageAggregation } from '@/components/ui/page-aggregation';
import { PageHeader } from '@/components/ui/page-header';
import { useEntityData } from '@/contexts/EntityDataContext';
import { useUnpriceableTokens } from '@/contexts/UnpriceableTokensContext';
import { useEnhancedToast } from '@/hooks/use-enhanced-toast';
import { useFilters } from '@/hooks/useFilters';
import type { ApiAccount, ApiHolding, ApiInstitution } from '@/lib/api-types';
import { BUTTON_TEXT } from '@/lib/button-constants';
import { withOptimisticHandlers } from '@/lib/cache/optimistic/entityManager';
import { trpc } from '@/lib/trpc';

export function Accounts() {
  const navigate = useNavigate();
  const { institutionId } = useParams<{ institutionId: string }>();
  const { success, error } = useEnhancedToast();
  const { isAccountAffected, shouldHighlight } = useUnpriceableTokens();
  const [searchTerm, setSearchTerm] = useState('');
  const [accountToDelete, setAccountToDelete] = useState<Account | null>(null);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);

  // Unified filter system
  const {
    filters: filterValues,
    updateFilter,
    clearAllFilters,
    hasActiveFilters,
  } = useFilters([
    { key: 'type', defaultValue: 'all' },
    { key: 'institution', defaultValue: 'all' },
  ]);

  const filterBy = filterValues.type || 'all';
  const filterByInstitution = filterValues.institution || 'all';

  // Compute hasActiveFilters - always include all filters and search term
  const hasActiveFiltersComputed = hasActiveFilters || Boolean(searchTerm);

  // Clear all filters helper - exits hierarchical mode when clearing all
  const handleClearAllFilters = () => {
    setSearchTerm('');

    // If in hierarchical mode, navigate back to normal accounts page immediately
    if (isHierarchicalMode) {
      // Navigate first, clearAllFilters will be called by the normal accounts page
      navigate('/accounts', { replace: true });
    } else {
      // In normal mode, just clear filters
      clearAllFilters();
    }
  };

  const {
    accounts: accountsState,
    institutions: institutionsState,
    accountTypes: accountTypesState,
  } = useEntityData();
  const accounts = accountsState.data;
  const institutions = institutionsState.data;
  const accountTypes = accountTypesState.data;
  const isLoading = accountsState.isLoading || institutionsState.isLoading;
  const { data: holdings } = trpc.holdings.getAll.useQuery();

  const { data: baseCurrency } = trpc.users.getBaseCurrency.useQuery();

  const { data: accountSummaries, isLoading: summariesLoading } =
    trpc.accounts.getSummaries.useQuery();

  // Determine if we're in hierarchical mode (accessed from institution)
  const isHierarchicalMode = Boolean(institutionId);
  const selectedInstitution = institutions?.find((inst) => inst.id === institutionId);

  // Sync institution filter when navigating between routes
  useEffect(() => {
    if (institutionId && institutionId !== filterByInstitution) {
      // Set the institution filter to match the URL param
      updateFilter('institution', institutionId);
    } else if (!institutionId && filterByInstitution !== 'all') {
      // Clear the institution filter when not in hierarchical mode
      updateFilter('institution', 'all');
    }
  }, [institutionId, filterByInstitution, updateFilter]);

  // Handle institution filter changes with navigation
  const handleInstitutionFilterChange = (value: string) => {
    if (value === 'all') {
      // User selected "All Institutions" - go to normal accounts page
      navigate('/accounts', { replace: true });
    } else if (value !== institutionId) {
      // User selected a different institution - navigate to that institution's page
      navigate(`/institutions/${value}`, { replace: true });
    }
    // If same institution selected, no navigation needed
  };

  // Filter accounts by institution if in hierarchical mode
  const baseAccounts = accounts || [];
  const displayAccounts = isHierarchicalMode
    ? baseAccounts.filter((account) => account.institutionId === institutionId)
    : baseAccounts;

  const utils = trpc.useUtils();

  const deleteAccount = trpc.accounts.delete.useMutation(
    withOptimisticHandlers('account', 'delete', utils, {
      onSuccess: (result) => {
        const { cascadeInfo } = result;
        let description = 'The account has been successfully deleted.';

        if (cascadeInfo && cascadeInfo.holdingsDeleted > 0) {
          description += ` Also deleted: ${
            cascadeInfo.holdingsDeleted
          } holding${cascadeInfo.holdingsDeleted !== 1 ? 's' : ''}.`;
          // Note: Transaction deletions are hidden from UI but still happen in backend
        }

        success(description);
        setIsDeleteDialogOpen(false);
        setAccountToDelete(null);
      },
      onError: (err) => {
        error(err.message);
      },
    })
  );

  // Create maps for quick lookups
  const institutionsMap = institutions
    ? Object.fromEntries(institutions.map((inst: ApiInstitution) => [inst.id, inst]))
    : {};

  // Filter accounts based on search term, type, and institution
  const filteredAccounts = displayAccounts.filter((account: ApiAccount) => {
    const matchesSearch =
      !searchTerm ||
      account.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (account.type?.toLowerCase().includes(searchTerm.toLowerCase()) ?? false) ||
      institutionsMap[account.institutionId]?.name.toLowerCase().includes(searchTerm.toLowerCase());

    const matchesTypeFilter = filterBy === 'all' || account.type === filterBy;
    const matchesInstitutionFilter =
      filterByInstitution === 'all' || account.institutionId === filterByInstitution;

    return matchesSearch && matchesTypeFilter && matchesInstitutionFilter;
  });

  // Action handlers
  const handleDeleteAccount = (account: Account) => {
    setAccountToDelete(account);
    setIsDeleteDialogOpen(true);
  };

  const confirmDeleteAccount = async () => {
    if (accountToDelete) {
      try {
        await deleteAccount.mutateAsync({ id: accountToDelete.id });
      } catch (error) {
        console.error('Error deleting account:', error);
      }
    }
  };

  // Screenshot handlers

  const getAccountHoldings = (accountId: string) => {
    if (!holdings) return [];
    return holdings.filter((holding: ApiHolding) => holding.accountId === accountId);
  };

  // Use backend-calculated account balances instead of manual calculations
  const getAccountBalance = (accountId: string): number => {
    if (!accountSummaries?.accounts) return 0;
    const accountSummary = accountSummaries.accounts.find((acc) => acc.id === accountId);
    return accountSummary?.totalBalance ?? 0;
  };

  if (isLoading || summariesLoading || !holdings || !institutions || !accountSummaries) {
    return (
      <div className="space-y-6">
        <PageHeader title="Accounts" subtitle="Manage your financial accounts" loading={true} />
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <Card key={i}>
              <CardContent className="p-6">
                <div className="animate-pulse space-y-4">
                  <div className="h-4 bg-muted rounded w-32"></div>
                  <div className="h-6 bg-muted rounded w-24"></div>
                  <div className="h-3 bg-muted rounded w-20"></div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  // Calculate total and filtered balances (ensure they're numbers)
  const allAccountsBalance =
    typeof accountSummaries?.totalBalance === 'number'
      ? accountSummaries.totalBalance
      : parseFloat(accountSummaries?.totalBalance?.toString() || '0');
  const displayAccountsBalance = displayAccounts.reduce((total, account) => {
    const accountBalance = getAccountBalance(account.id);
    return total + accountBalance;
  }, 0);
  const filteredBalance = filteredAccounts.reduce((total, account) => {
    const accountBalance = getAccountBalance(account.id);
    return total + accountBalance;
  }, 0);

  const totalBalance = isHierarchicalMode ? displayAccountsBalance : allAccountsBalance;

  // Check if any accounts are affected by unpriceable tokens and should be highlighted
  const hasAffectedAccounts =
    shouldHighlight() &&
    baseAccounts.some((account) => {
      const institution = institutions.find((inst) => inst.id === account.institutionId);
      return institution ? isAccountAffected(institution.name, account.name) : false;
    });

  const pageTitle =
    isHierarchicalMode && selectedInstitution
      ? `${selectedInstitution.name} Accounts`
      : 'Your Accounts';

  const pageSubtitle = isHierarchicalMode
    ? `Accounts at ${selectedInstitution?.name || 'this institution'}`
    : 'Overview of your financial accounts with holdings';

  return (
    <div className="space-y-4">
      <PageHeader title={pageTitle} subtitle={pageSubtitle} />

      <PageAggregation
        totalCount={baseAccounts.length}
        filteredCount={filteredAccounts.length}
        entityLabel="accounts"
        totalBalance={totalBalance}
        filteredBalance={filteredBalance}
        baseCurrency={baseCurrency?.symbol}
        searchTerm={searchTerm}
        onSearchChange={setSearchTerm}
        searchPlaceholder="Search accounts by name, type, institution, or account number..."
        hasActiveFilters={hasActiveFiltersComputed}
        onClearFilters={handleClearAllFilters}
        filters={[
          <AccountTypeSelector
            key="type"
            value={filterBy}
            onValueChange={(value) => updateFilter('type', value)}
            accountTypes={[{ id: 'all', code: 'all', name: 'All Types' }, ...(accountTypes || [])]}
            placeholder="Filter by type..."
          />,
          <InstitutionFilterSelector
            key="institution"
            value={filterByInstitution}
            onValueChange={handleInstitutionFilterChange}
            institutions={institutions}
            placeholder="Filter by institution..."
          />,
        ]}
        isAffectedByUnpriceableTokens={hasAffectedAccounts}
      />

      {/* Accounts Grid */}
      {!isHierarchicalMode && displayAccounts.length === 0 ? (
        <AccountsEmptyState />
      ) : filteredAccounts.length === 0 ? (
        <NoResultsEmptyState onClearFilters={handleClearAllFilters} />
      ) : (
        <div className="space-y-4">
          {filteredAccounts.map((account: ApiAccount) => {
            const accountBalance = getAccountBalance(account.id);
            const institution = institutionsMap[account.institutionId];
            const accountHoldings = getAccountHoldings(account.id);
            return (
              <div key={account.id}>
                <AccountRow
                  account={{
                    ...account,
                    institution: !isHierarchicalMode ? institution : undefined,
                    balance: accountBalance,
                    holdingCount: accountHoldings.length,
                  }}
                  userPrefs={{
                    baseCurrency: baseCurrency || undefined,
                  }}
                  showInstitution={!isHierarchicalMode}
                  onDelete={() => handleDeleteAccount(account as unknown as Account)}
                  onClick={
                    accountHoldings.length > 0
                      ? () => {
                          if (isHierarchicalMode) {
                            navigate(`/institutions/${institutionId}/accounts/${account.id}`);
                          } else {
                            navigate(
                              `/institutions/${account.institutionId}/accounts/${account.id}`
                            );
                          }
                        }
                      : undefined
                  }
                />
              </div>
            );
          })}
        </div>
      )}

      {/* Delete Confirmation Dialog */}
      <Dialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Account</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete "{accountToDelete?.name}"? This action cannot be
              undone. All associated holdings will also be permanently deleted.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setIsDeleteDialogOpen(false)}
              disabled={deleteAccount.isPending}
            >
              {BUTTON_TEXT.CANCEL}
            </Button>
            <Button
              variant="destructive"
              onClick={confirmDeleteAccount}
              disabled={deleteAccount.isPending}
            >
              {deleteAccount.isPending ? 'Deleting...' : BUTTON_TEXT.DELETE_ACCOUNT}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
