import { FinancialMath } from '@scani/shared';
import { PieChart, Plus } from 'lucide-react';
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
import { MonetaryValue } from '@/components/ui/monetary-value';
import { PageAggregation } from '@/components/ui/page-aggregation';
import { PageHeader } from '@/components/ui/page-header';
import { useToast } from '@/hooks/use-toast';
import { useFilters } from '@/hooks/useFilters';
import type { ApiAccount, ApiHolding, ApiInstitution, ApiToken } from '@/lib/api-types';
import { BUTTON_TEXT } from '@/lib/button-constants';
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

  const { data: holdings, isLoading: holdingsLoading } = trpc.holdings.getAll.useQuery();
  const { data: accounts } = trpc.accounts.getAll.useQuery();
  const { data: tokens } = trpc.tokens.getAll.useQuery();
  const { data: userPrefs } = trpc.users.getCurrent.useQuery();
  const { data: institutions } = trpc.institutions.getAll.useQuery();
  const { data: tokenTypes } = trpc.tokenTypes.getAll.useQuery();
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
  const [isViewDialogOpen, setIsViewDialogOpen] = useState(false);
  const [holdingToView, setHoldingToView] = useState<ProcessedHolding | undefined>();

  const utils = trpc.useUtils();
  const { toast } = useToast();

  const deleteHolding = trpc.holdings.delete.useMutation({
    onSuccess: () => {
      toast({
        title: 'Success',
        description: `Holding for "${
          holdingToDelete?.token?.symbol || 'token'
        }" has been deleted successfully.`,
        variant: 'success',
      });
      utils.holdings.getAll.invalidate();
      setIsDeleteDialogOpen(false);
      setHoldingToDelete(undefined);
    },
    onError: (error) => {
      toast({
        title: 'Error',
        description: error.message || 'Failed to delete holding. Please try again.',
        variant: 'destructive',
      });
    },
  });

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

    // Try to find the portfolio value for this holding's token
    const portfolioHolding = portfolioValue?.holdings.find(
      (ph) => ph.tokenSymbol === token?.symbol
    );

    return {
      ...holding,
      token,
      account,
      institution,
      value: portfolioHolding?.value
        ? parseFloat(portfolioHolding.value)
        : FinancialMath.toNumber(FinancialMath.abs(holding.balance ?? 0)), // fallback to raw balance
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

  const handleAddHolding = () => {
    navigate('/quick-add-holding');
  };

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

  const handleViewHolding = (holding: ProcessedHolding) => {
    setHoldingToView(holding);
    setIsViewDialogOpen(true);
  };

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

  const pageTitle =
    isHierarchicalMode && selectedAccount ? `${selectedAccount.name} Holdings` : 'Holdings';

  const pageSubtitle =
    isHierarchicalMode && selectedAccount
      ? `Holdings in ${selectedAccount.name}`
      : 'Manage your investment positions';

  return (
    <div className="space-y-4">
      <PageHeader
        title={pageTitle}
        subtitle={pageSubtitle}
        primaryAction={{
          label: BUTTON_TEXT.CREATE_HOLDING,
          onClick: handleAddHolding,
          icon: <Plus className="h-4 w-4 mr-1" />,
        }}
      />

      <PageAggregation
        totalCount={baseHoldings.length}
        filteredCount={filteredHoldings.length}
        entityLabel="holdings"
        totalBalance={totalValue}
        filteredBalance={filteredValue}
        baseCurrency={userPrefs?.baseCurrency?.symbol}
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
      />

      {/* Holdings List */}
      {!processedHoldings || processedHoldings.length === 0 ? (
        <Card>
          <CardContent className="p-12 text-center">
            <PieChart className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
            <div className="text-muted-foreground mb-4">No holdings found</div>
            <Button onClick={handleAddHolding}>
              <Plus className="h-4 w-4 mr-2" />
              {BUTTON_TEXT.ADD_FIRST_HOLDING}
            </Button>
          </CardContent>
        </Card>
      ) : sortedHoldings.length === 0 ? (
        <Card>
          <CardContent className="p-12 text-center">
            <div className="text-muted-foreground mb-4">No holdings match your search criteria</div>
            <Button onClick={handleClearAllFilters}>Clear Filters</Button>
          </CardContent>
        </Card>
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
                  baseCurrency: userPrefs?.baseCurrency || undefined,
                }}
                onView={() => handleViewHolding(holding)}
                onEdit={() => handleEditHolding(holding)}
                onDelete={() => handleDeleteHolding(holding)}
                onClick={() => {
                  const account = accounts?.find((acc) => acc.id === holding.accountId);
                  if (account) {
                    navigate(
                      `/institutions/${account.institutionId}/accounts/${account.id}/holdings/${holding.id}`
                    );
                  } else {
                    // Fallback to old route if account not found
                    navigate(`/transactions?holding=${holding.id}`);
                  }
                }}
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

      {/* View Holding Details Dialog */}
      <Dialog open={isViewDialogOpen} onOpenChange={setIsViewDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Holding Details</DialogTitle>
            <DialogDescription>Complete information about this holding</DialogDescription>
          </DialogHeader>
          {holdingToView && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-sm font-medium text-muted-foreground">Token</p>
                  <p className="font-semibold">
                    {holdingToView.token?.name} ({holdingToView.token?.symbol})
                  </p>
                  <p className="text-xs text-muted-foreground capitalize">
                    {holdingToView.token?.type}
                  </p>
                </div>
                <div>
                  <p className="text-sm font-medium text-muted-foreground">Current Value</p>
                  <MonetaryValue
                    type="currency"
                    value={holdingToView.value}
                    currency={userPrefs?.baseCurrency?.symbol}
                    size="lg"
                    className="font-semibold"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-sm font-medium text-muted-foreground">Balance</p>
                  <MonetaryValue
                    type="token"
                    value={parseFloat(holdingToView.balance || '0')}
                    tokenSymbol={holdingToView.token?.symbol || ''}
                    decimals={holdingToView.token?.decimals}
                    className="font-semibold"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-sm font-medium text-muted-foreground">Account</p>
                  <p className="font-semibold">{holdingToView.account?.name}</p>
                  <p className="text-xs text-muted-foreground">{holdingToView.institution?.name}</p>
                </div>
                <div>
                  <p className="text-sm font-medium text-muted-foreground">Last Updated</p>
                  <p className="font-semibold">
                    {new Date(holdingToView.lastUpdated).toLocaleDateString()}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {new Date(holdingToView.lastUpdated).toLocaleTimeString()}
                  </p>
                </div>
              </div>
              <div>
                <p className="text-sm font-medium text-muted-foreground">Created</p>
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
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Holding</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this holding for "{holdingToDelete?.token?.name}"?
              This action cannot be undone and will permanently remove the holding record and all
              associated transactions.
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
