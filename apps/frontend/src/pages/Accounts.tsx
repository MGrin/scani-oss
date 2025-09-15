import type { Account } from '@scani/shared';
import { MoreHorizontal, Plus, Trash2, Wallet } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  AccountTypeSelector,
  InstitutionFilterSelector,
} from '@/components/selectors/SearchableSelectors';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

import { PageAggregation } from '@/components/ui/page-aggregation';
import { PageHeader } from '@/components/ui/page-header';
import { ItemCard, MiniSummaryCard } from '@/components/ui/summary-cards';
import { useToast } from '@/hooks/use-toast';
import type { ApiAccount, ApiHolding, ApiInstitution } from '@/lib/api-types';
import { BUTTON_TEXT } from '@/lib/button-constants';
import { getAccountTypeIcon } from '@/lib/icons';
import { trpc } from '@/lib/trpc';

export function Accounts() {
  const navigate = useNavigate();
  const { institutionId } = useParams<{ institutionId: string }>();
  const { toast } = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [searchTerm, setSearchTerm] = useState('');
  const [filterBy, setFilterBy] = useState<string>(searchParams.get('type') || 'all');
  const [filterByInstitution, setFilterByInstitution] = useState<string>(
    searchParams.get('institution') || 'all'
  );
  const [accountToDelete, setAccountToDelete] = useState<Account | null>(null);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);

  // Update filter when URL parameters change
  useEffect(() => {
    const typeParam = searchParams.get('type');
    if (typeParam) {
      setFilterBy(typeParam);
    } else {
      setFilterBy('all');
    }

    const institutionParam = searchParams.get('institution');
    if (institutionParam) {
      setFilterByInstitution(institutionParam);
    } else {
      setFilterByInstitution('all');
    }
  }, [searchParams]);

  // Update URL when filter changes
  const handleFilterChange = (newFilter: string) => {
    setFilterBy(newFilter);
    const newSearchParams = new URLSearchParams(searchParams);
    if (newFilter === 'all') {
      newSearchParams.delete('type');
    } else {
      newSearchParams.set('type', newFilter);
    }
    setSearchParams(newSearchParams);
  };

  // Update URL when institution filter changes
  const handleInstitutionFilterChange = (newFilter: string) => {
    setFilterByInstitution(newFilter);
    const newSearchParams = new URLSearchParams(searchParams);
    if (newFilter === 'all') {
      newSearchParams.delete('institution');
    } else {
      newSearchParams.set('institution', newFilter);
    }
    setSearchParams(newSearchParams);
  };

  const { data: accounts, isLoading } = trpc.accounts.getAll.useQuery();
  const { data: holdings } = trpc.holdings.getAll.useQuery();
  const { data: institutions } = trpc.institutions.getAll.useQuery();
  const { data: tokens } = trpc.tokens.getAll.useQuery();
  const { data: userPrefs } = trpc.users.getCurrent.useQuery();
  const { data: accountSummaries, isLoading: summariesLoading } =
    trpc.accounts.getSummaries.useQuery();
  const { data: accountTypes } = trpc.accountTypes.getAll.useQuery();

  // Determine if we're in hierarchical mode (accessed from institution)
  const isHierarchicalMode = Boolean(institutionId);
  const selectedInstitution = institutions?.find((inst) => inst.id === institutionId);

  // Filter accounts by institution if in hierarchical mode
  const baseAccounts = accounts || [];
  const displayAccounts = isHierarchicalMode
    ? baseAccounts.filter((account) => account.institutionId === institutionId)
    : baseAccounts;

  const utils = trpc.useUtils();

  const deleteAccount = trpc.accounts.delete.useMutation({
    onSuccess: (result) => {
      const { cascadeInfo } = result;
      let description = 'The account has been successfully deleted.';

      if (cascadeInfo && (cascadeInfo.holdingsDeleted > 0 || cascadeInfo.transactionsDeleted > 0)) {
        const parts = [];
        if (cascadeInfo.holdingsDeleted > 0) {
          parts.push(
            `${cascadeInfo.holdingsDeleted} holding${cascadeInfo.holdingsDeleted !== 1 ? 's' : ''}`
          );
        }
        if (cascadeInfo.transactionsDeleted > 0) {
          parts.push(
            `${cascadeInfo.transactionsDeleted} transaction${
              cascadeInfo.transactionsDeleted !== 1 ? 's' : ''
            }`
          );
        }
        description += ` Also deleted: ${parts.join(' and ')}.`;
      }

      toast({
        title: 'Account deleted',
        description,
      });
      utils.accounts.getAll.invalidate();
      utils.holdings.getAll.invalidate();
      setIsDeleteDialogOpen(false);
      setAccountToDelete(null);
    },
    onError: (error) => {
      toast({
        title: 'Error deleting account',
        description: error.message,
        variant: 'destructive',
      });
    },
  });

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

  const confirmDeleteAccount = () => {
    if (accountToDelete) {
      deleteAccount.mutate({ id: accountToDelete.id });
    }
  };

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

  if (isLoading || summariesLoading || !holdings || !institutions || !tokens || !accountSummaries) {
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

  const pageTitle =
    isHierarchicalMode && selectedInstitution
      ? `${selectedInstitution.name} Accounts`
      : 'Your Accounts';

  const pageSubtitle = isHierarchicalMode
    ? `Accounts at ${selectedInstitution?.name || 'this institution'}`
    : 'Overview of your financial accounts with holdings';

  return (
    <div className="space-y-4">
      <PageHeader
        title={pageTitle}
        subtitle={pageSubtitle}
        primaryAction={{
          label: 'Add Holding',
          onClick: () => navigate('/quick-add-holding'),
          icon: <Plus className="h-4 w-4 mr-1" />,
        }}
      />

      <PageAggregation
        totalCount={displayAccounts.length}
        filteredCount={filteredAccounts.length}
        entityLabel="accounts"
        totalBalance={totalBalance}
        filteredBalance={filteredBalance}
        baseCurrency={userPrefs?.baseCurrency?.symbol}
        searchTerm={searchTerm}
        onSearchChange={setSearchTerm}
        searchPlaceholder="Search accounts by name, type, institution, or account number..."
        filterBy={filterBy}
        onFilterChange={handleFilterChange}
        customFilter={
          <div className="flex gap-2">
            <div className="md:w-64">
              <AccountTypeSelector
                value={filterBy}
                onValueChange={handleFilterChange}
                accountTypes={[
                  { id: 'all', code: 'all', name: 'All Types' },
                  ...(accountTypes || []),
                ]}
                placeholder="Filter by type..."
              />
            </div>
            {!isHierarchicalMode && (
              <div className="md:w-64">
                <InstitutionFilterSelector
                  value={filterByInstitution}
                  onValueChange={handleInstitutionFilterChange}
                  institutions={institutions}
                  placeholder="Filter by institution..."
                />
              </div>
            )}
          </div>
        }
      />

      {/* Accounts Grid */}
      {displayAccounts.length === 0 ? (
        <Card>
          <CardContent className="p-12 text-center">
            <Wallet className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold mb-2">No accounts yet</h3>
            <p className="text-muted-foreground mb-6 max-w-md mx-auto">
              You haven't added any holdings yet. When you create your first holding, the associated
              account will appear here automatically.
            </p>
            <Button onClick={() => navigate('/quick-add-holding')}>
              <Plus className="h-4 w-4 mr-2" />
              Create Your First Holding
            </Button>
          </CardContent>
        </Card>
      ) : filteredAccounts.length === 0 ? (
        <Card>
          <CardContent className="p-12 text-center">
            <div className="text-muted-foreground mb-4">No accounts match your search criteria</div>
            <Button
              onClick={() => {
                setSearchTerm('');
                setFilterBy('all');
                setFilterByInstitution('all');
                // Clear URL params too
                navigate('/accounts');
              }}
            >
              Clear Filters
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {filteredAccounts.map((account: ApiAccount) => {
            const IconComponent = getAccountTypeIcon(account.type ?? 'other');
            const accountBalance = getAccountBalance(account.id);
            const institution = institutionsMap[account.institutionId];
            const accountHoldings = getAccountHoldings(account.id);
            return (
              <div key={account.id}>
                <ItemCard
                  title={account.name}
                  subtitle={
                    <div className="space-y-1">
                      {!isHierarchicalMode && (
                        <div className="text-xs text-muted-foreground">
                          {institution?.name || 'Unknown Institution'} •{' '}
                          {account.type?.replace('_', ' ') ?? 'Unknown Type'}
                        </div>
                      )}
                      {isHierarchicalMode && (
                        <div className="text-xs text-muted-foreground">
                          {account.type?.replace('_', ' ') ?? 'Unknown Type'}
                        </div>
                      )}
                      <div className="flex items-center space-x-2 text-xs text-muted-foreground">
                        <span>{accountHoldings.length} holdings</span>
                        <span>•</span>
                        <span>Updated {new Date(account.updatedAt).toLocaleDateString()}</span>
                      </div>
                    </div>
                  }
                  currencyValue={accountBalance}
                  currency={userPrefs?.baseCurrency?.symbol}
                  icon={
                    IconComponent && <IconComponent className="h-8 w-8 text-muted-foreground" />
                  }
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
                  actions={
                    <div className="flex items-center space-x-2">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="sm">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onClick={() => handleDeleteAccount(account as unknown as Account)}
                            className="text-destructive"
                          >
                            <Trash2 className="h-4 w-4 mr-2" />
                            {BUTTON_TEXT.DELETE_ACCOUNT}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  }
                />
              </div>
            );
          })}
        </div>
      )}

      {/* Account Types Legend */}
      {accounts && accounts.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Account Types</CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
              {accountSummaries?.typesSummary?.map((typeSummary) => {
                if (typeSummary.accountCount === 0) return null;

                const IconComponent = getAccountTypeIcon(typeSummary.type);

                return (
                  <MiniSummaryCard
                    key={typeSummary.type}
                    title={typeSummary.typeName}
                    value={typeSummary.totalBalance}
                    currency={userPrefs?.baseCurrency?.symbol}
                    count={typeSummary.accountCount}
                    icon={IconComponent}
                  />
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Delete Confirmation Dialog */}
      <Dialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Account</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete "{accountToDelete?.name}"? This action cannot be
              undone. All associated holdings and transactions will also be permanently deleted.
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
