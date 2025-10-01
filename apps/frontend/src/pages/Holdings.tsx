import { Decimal, FinancialMath } from '@scani/shared';
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { HoldingForm } from '@/components/HoldingForm';
import { HoldingRow } from '@/components/HoldingRow';

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
import { HoldingsEmptyState, NoResultsEmptyState } from '@/components/ui/empty-state';

import { PageAggregation } from '@/components/ui/page-aggregation';
import { PageHeader } from '@/components/ui/page-header';
import { useEntityData } from '@/contexts/EntityDataContext';
import { useUnpriceableTokens } from '@/contexts/UnpriceableTokensContext';
import { useEnhancedToast } from '@/hooks/use-enhanced-toast';
import { useFilters } from '@/hooks/useFilters';
import type { ApiAccount, ApiHolding, ApiInstitution, ApiToken } from '@/lib/api-types';
import { BUTTON_TEXT } from '@/lib/button-constants';
import { withOptimisticHandlers } from '@/lib/cache/optimistic/entityManager';
import { trpc } from '@/lib/trpc';
import {
  AccountFilterSelector,
  TokenFilterSelector,
  TokenTypeSelector,
} from '../components/selectors/SearchableSelectors';

interface ProcessedHolding extends ApiHolding {
  token: ApiToken | undefined;
  account: ApiAccount | undefined;
  institution: ApiInstitution | null | undefined;
  value: number;
}

export function Holdings() {
  const navigate = useNavigate();
  const { institutionId, accountId } = useParams<{
    institutionId: string;
    accountId: string;
  }>();
  const { isTokenUnpriceable, shouldHighlight } = useUnpriceableTokens();

  const { data: holdings, isLoading: holdingsLoading } = trpc.holdings.getAll.useQuery(undefined, {
    refetchOnMount: 'always', // Always refetch to ensure fresh data after mutations
  });
  const {
    accounts: accountsState,
    institutions: institutionsState,
    tokenTypes: tokenTypesState,
  } = useEntityData();
  const accounts = accountsState.data;
  // Use optimized endpoints - only get tokens user has holdings for, and base currency separately
  const { data: tokens } = trpc.tokens.getByUserId.useQuery(undefined, {
    refetchOnMount: 'always', // Always refetch to ensure fresh data after mutations
  });

  const { data: baseCurrency } = trpc.users.getBaseCurrency.useQuery();

  const institutions = institutionsState.data;
  const tokenTypes = tokenTypesState.data;
  const { data: portfolioValue, isLoading: portfolioLoading } =
    trpc.users.getPortfolioValue.useQuery();

  // Determine if we're in hierarchical mode
  const isHierarchicalMode = Boolean(institutionId && accountId);
  const selectedAccount = accounts?.find((acc) => acc.id === accountId);

  // Filter holdings by account if in hierarchical mode
  const baseHoldings = holdings || [];
  const displayHoldings = isHierarchicalMode
    ? baseHoldings.filter((holding) => holding.accountId === accountId)
    : baseHoldings;

  const [searchTerm, setSearchTerm] = useState('');

  // Unified filter system
  const {
    filters: filterValues,
    updateFilter,
    clearAllFilters,
    hasActiveFilters,
  } = useFilters([
    { key: 'type', defaultValue: 'all' },
    { key: 'account', defaultValue: 'all' },
    { key: 'token', defaultValue: 'all' },
  ]);

  const filterBy = filterValues.type || 'all';
  const filterByAccount = filterValues.account || 'all';
  const filterByToken = filterValues.token || 'all';

  // Compute hasActiveFilters - always include all filters and search term
  const hasActiveFiltersComputed = hasActiveFilters || Boolean(searchTerm);

  // Sync account filter when navigating between routes
  useEffect(() => {
    if (accountId && accountId !== filterByAccount) {
      // Set the account filter to match the URL param
      updateFilter('account', accountId);
    } else if (!accountId && filterByAccount !== 'all') {
      // Clear the account filter when not in hierarchical mode
      updateFilter('account', 'all');
    }
  }, [accountId, filterByAccount, updateFilter]);

  // Handle account filter changes with navigation
  const handleAccountFilterChange = (value: string) => {
    if (value === 'all') {
      // User selected "All Accounts" - go to normal holdings page
      navigate('/holdings', { replace: true });
    } else if (value !== accountId) {
      // User selected a single account - navigate to that account's holdings page
      // Need to find the institution for this account
      const account = accounts?.find((acc) => acc.id === value);
      if (account) {
        navigate(`/institutions/${account.institutionId}/accounts/${value}`, {
          replace: true,
        });
      }
    }
    // If same account selected, no navigation needed
  };

  // Clear all filters helper - exits hierarchical mode when clearing all
  const handleClearAllFilters = () => {
    setSearchTerm('');

    // If in hierarchical mode, navigate back to normal holdings page
    if (isHierarchicalMode) {
      navigate('/holdings', { replace: true });
    } else {
      // In normal mode, just clear filters
      clearAllFilters();
    }
  };

  const [isHoldingFormOpen, setIsHoldingFormOpen] = useState(false);
  const [holdingToEdit, setHoldingToEdit] = useState<ApiHolding | undefined>();
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [holdingToDelete, setHoldingToDelete] = useState<ProcessedHolding | undefined>();
  // HIDDEN: Transaction UI temporarily hidden
  // const [isViewDialogOpen, setIsViewDialogOpen] = useState(false);
  // const [holdingToView, setHoldingToView] = useState<
  //   ProcessedHolding | undefined
  // >();

  const utils = trpc.useUtils();
  const { success, error: showError } = useEnhancedToast();

  const deleteHolding = trpc.holdings.delete.useMutation(
    withOptimisticHandlers('holding', 'delete', utils, {
      onSuccess: () => {
        const description = `Holding for "${
          holdingToDelete?.token?.symbol || 'token'
        }" has been deleted successfully.`;
        // Note: Associated transactions are also deleted in the backend but not mentioned in UI

        success(description, 'Success');
        setIsDeleteDialogOpen(false);
        setHoldingToDelete(undefined);
      },
      onError: (error) => {
        showError(error.message || 'Failed to delete holding. Please try again.', 'Error');
      },
    })
  );

  // Create maps for quick lookups
  const tokensMap = tokens
    ? Object.fromEntries(tokens.map((token: ApiToken) => [token.id, token]))
    : {};
  const accountsMap = accounts
    ? Object.fromEntries(accounts.map((account: ApiAccount) => [account.id, account]))
    : {};
  const institutionsMap = institutions
    ? Object.fromEntries(institutions.map((inst: ApiInstitution) => [inst.id, inst]))
    : {};

  // Process holdings with portfolio values and related data
  const processedHoldings: ProcessedHolding[] = displayHoldings.map((holding: ApiHolding) => {
    const token = tokensMap[holding.tokenId];
    const account = accountsMap[holding.accountId];
    const institution = account ? institutionsMap[account.institutionId] : null;

    // Calculate individual holding value based on its proportion of total token balance
    let value = FinancialMath.toNumber(FinancialMath.abs(holding.balance ?? '0')); // fallback to raw balance

    if (portfolioValue?.holdings && token?.symbol) {
      const portfolioHolding = portfolioValue.holdings.find(
        (ph) => ph.tokenSymbol === token.symbol
      );

      if (portfolioHolding?.value && portfolioHolding?.balance) {
        // Calculate this holding's proportion of the total token balance
        const holdingBalance = FinancialMath.toNumber(new Decimal(holding.balance ?? '0'));
        const totalTokenBalance = FinancialMath.toNumber(new Decimal(portfolioHolding.balance));
        const totalTokenValue = parseFloat(portfolioHolding.value);

        if (totalTokenBalance > 0) {
          // Calculate proportional value for this specific holding
          value = (holdingBalance / totalTokenBalance) * totalTokenValue;
        }
      }
    }

    return {
      ...holding,
      token,
      account,
      institution,
      value,
    };
  });

  // Apply filters and search
  const filteredHoldings = processedHoldings.filter((holding: ProcessedHolding) => {
    const matchesSearch =
      !searchTerm ||
      holding.token?.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      holding.token?.symbol.toLowerCase().includes(searchTerm.toLowerCase()) ||
      holding.account?.name.toLowerCase().includes(searchTerm.toLowerCase());

    const matchesTypeFilter = filterBy === 'all' || holding.token?.type === filterBy;
    const matchesAccountFilter = filterByAccount === 'all' || holding.accountId === filterByAccount;
    const matchesTokenFilter = filterByToken === 'all' || holding.tokenId === filterByToken;

    return matchesSearch && matchesTypeFilter && matchesAccountFilter && matchesTokenFilter;
  });

  // Sort by balance (highest to lowest) by default
  const sortedHoldings = [...filteredHoldings].sort((a, b) => {
    return b.value - a.value; // Descending order by value
  });

  const handleEditHolding = (holding: ProcessedHolding) => {
    setHoldingToEdit({
      id: holding.id,
      userId: holding.userId,
      accountId: holding.accountId,
      tokenId: holding.tokenId,
      balance: holding.balance,
      lastUpdated: holding.lastUpdated,
      createdAt: holding.createdAt,
    });
    setIsHoldingFormOpen(true);
  };

  const handleDeleteHolding = (holding: ProcessedHolding) => {
    setHoldingToDelete(holding);
    setIsDeleteDialogOpen(true);
  };

  // HIDDEN: Transaction UI temporarily hidden
  // const handleViewHolding = (holding: ProcessedHolding) => {
  //   setHoldingToView(holding);
  //   setIsViewDialogOpen(true);
  // };

  const confirmDeleteHolding = () => {
    if (holdingToDelete) {
      deleteHolding.mutate({ id: holdingToDelete.id });
    }
  };

  if (holdingsLoading || portfolioLoading || !tokens || !accounts || !institutions) {
    return (
      <div className="space-y-4">
        <PageHeader title="Holdings" subtitle="Manage your investment positions" loading={true} />
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

  // Calculate totals
  const totalValue = processedHoldings.reduce((sum, holding) => sum + holding.value, 0);
  const filteredValue = filteredHoldings.reduce((sum, holding) => sum + holding.value, 0);

  // Check if any holdings have unpriceable tokens and should be highlighted
  const hasUnpriceableTokenHoldings =
    shouldHighlight() &&
    processedHoldings.some((holding) =>
      holding.token ? isTokenUnpriceable(holding.token.symbol) : false
    );

  const pageTitle =
    isHierarchicalMode && selectedAccount ? `${selectedAccount.name} Holdings` : 'Holdings';

  const pageSubtitle =
    isHierarchicalMode && selectedAccount
      ? `Holdings in ${selectedAccount.name}`
      : 'Manage your investment positions';

  return (
    <div className="space-y-4">
      <PageHeader title={pageTitle} subtitle={pageSubtitle} />

      <PageAggregation
        totalCount={baseHoldings.length}
        filteredCount={filteredHoldings.length}
        entityLabel="holdings"
        totalBalance={totalValue}
        filteredBalance={filteredValue}
        baseCurrency={baseCurrency?.symbol}
        searchTerm={searchTerm}
        onSearchChange={setSearchTerm}
        searchPlaceholder="Search holdings by token name, symbol, or account..."
        hasActiveFilters={hasActiveFiltersComputed}
        onClearFilters={handleClearAllFilters}
        filters={[
          <TokenTypeSelector
            key="type"
            value={filterBy}
            onValueChange={(value) => updateFilter('type', value)}
            tokenTypes={[{ id: 'all', code: 'all', name: 'All Types' }, ...(tokenTypes || [])]}
            placeholder="Filter by type..."
          />,
          <AccountFilterSelector
            key="account"
            value={filterByAccount}
            onValueChange={handleAccountFilterChange}
            accounts={accounts}
            institutions={institutions}
            placeholder="Filter by account..."
          />,
          <TokenFilterSelector
            key="token"
            value={filterByToken}
            onValueChange={(value: string) => updateFilter('token', value)}
            tokens={tokens}
            placeholder="Filter by token..."
          />,
        ]}
        isAffectedByUnpriceableTokens={hasUnpriceableTokenHoldings}
      />

      {/* Holdings List */}
      {!processedHoldings || processedHoldings.length === 0 ? (
        <HoldingsEmptyState />
      ) : sortedHoldings.length === 0 ? (
        <NoResultsEmptyState onClearFilters={handleClearAllFilters} />
      ) : (
        <div className="space-y-4">
          {sortedHoldings.map((holding) => {
            return (
              <HoldingRow
                key={holding.id}
                holding={{
                  ...holding,
                  institution: holding.institution || undefined,
                }}
                userPrefs={{
                  baseCurrency: baseCurrency || undefined,
                }}
                // onView={() => handleViewHolding(holding)} // HIDDEN: Transaction UI temporarily hidden
                onEdit={() => handleEditHolding(holding)}
                onDelete={() => handleDeleteHolding(holding)}
                // HIDDEN: Transaction UI temporarily hidden - no onClick navigation
                // onClick={() => {
                //   const account = accounts?.find(
                //     (acc) => acc.id === holding.accountId
                //   );
                //   if (account) {
                //     navigate(
                //       `/institutions/${account.institutionId}/accounts/${account.id}/holdings/${holding.id}`
                //     );
                //   } else {
                //     // Fallback to old route if account not found
                //     navigate(`/transactions?holding=${holding.id}`);
                //   }
                // }}
              />
            );
          })}
        </div>
      )}

      {/* Holding Form Dialog */}
      <HoldingForm
        isOpen={isHoldingFormOpen}
        onClose={() => setIsHoldingFormOpen(false)}
        holding={holdingToEdit}
        mode={holdingToEdit ? 'edit' : 'create'}
      />

      {/* HIDDEN: Transaction UI temporarily hidden */}
      {/* View Holding Details Dialog */}
      {/* <Dialog open={isViewDialogOpen} onOpenChange={setIsViewDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Holding Details</DialogTitle>
            <DialogDescription>
              Complete information about this holding
            </DialogDescription>
          </DialogHeader>
          {holdingToView && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-sm font-medium text-muted-foreground">
                    Token
                  </p>
                  <p className="font-semibold">
                    {holdingToView.token?.name} ({holdingToView.token?.symbol})
                  </p>
                  <p className="text-xs text-muted-foreground capitalize">
                    {holdingToView.token?.type}
                  </p>
                </div>
                <div>
                  <p className="text-sm font-medium text-muted-foreground">
                    Current Value
                  </p>
                  <MonetaryValue
                    type="currency"
                    value={holdingToView.value}
                    currency={baseCurrency?.symbol}
                    size="lg"
                    className="font-semibold"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-sm font-medium text-muted-foreground">
                    Balance
                  </p>
                  <MonetaryValue
                    type="token"
                    value={parseFloat(holdingToView.balance || "0")}
                    tokenSymbol={holdingToView.token?.symbol || ""}
                    decimals={holdingToView.token?.decimals}
                    className="font-semibold"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-sm font-medium text-muted-foreground">
                    Account
                  </p>
                  <p className="font-semibold">{holdingToView.account?.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {holdingToView.institution?.name}
                  </p>
                </div>
                <div>
                  <p className="text-sm font-medium text-muted-foreground">
                    Last Updated
                  </p>
                  <p className="font-semibold">
                    {new Date(holdingToView.lastUpdated).toLocaleDateString()}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {new Date(holdingToView.lastUpdated).toLocaleTimeString()}
                  </p>
                </div>
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">
                  Created
                </p>
                <p className="font-semibold">
                  {new Date(holdingToView.createdAt).toLocaleDateString()}
                </p>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => setIsViewDialogOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog> */}

      {/* Delete Confirmation Dialog */}
      <Dialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Holding</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this holding for "{holdingToDelete?.token?.name}"?
              This action cannot be undone and will permanently remove the holding record.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setIsDeleteDialogOpen(false)}
              disabled={deleteHolding.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={confirmDeleteHolding}
              disabled={deleteHolding.isPending}
            >
              {deleteHolding.isPending ? 'Deleting...' : BUTTON_TEXT.DELETE_HOLDING}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
