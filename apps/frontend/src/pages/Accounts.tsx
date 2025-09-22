import type { Account } from "@scani/shared";
import { Wallet } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { AccountRow } from "@/components/AccountRow";

import {
  AccountTypeSelector,
  InstitutionFilterSelector,
} from "@/components/selectors/SearchableSelectors";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PageAggregation } from "@/components/ui/page-aggregation";
import { PageHeader } from "@/components/ui/page-header";
import { useUnpriceableTokens } from "@/contexts/UnpriceableTokensContext";
import { useToast } from "@/hooks/use-toast";
import { useFilters } from "@/hooks/useFilters";
import type { ApiAccount, ApiHolding, ApiInstitution } from "@/lib/api-types";
import { BUTTON_TEXT } from "@/lib/button-constants";
import { trpc } from "@/lib/trpc";

export function Accounts() {
  const navigate = useNavigate();
  const { institutionId } = useParams<{ institutionId: string }>();
  const { toast } = useToast();
  const { isAccountAffected, shouldHighlight } = useUnpriceableTokens();
  const [searchTerm, setSearchTerm] = useState("");
  const [accountToDelete, setAccountToDelete] = useState<Account | null>(null);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);

  // Unified filter system
  const {
    filters: filterValues,
    updateFilter,
    clearAllFilters,
    hasActiveFilters,
  } = useFilters([
    { key: "type", defaultValue: "all" },
    { key: "institution", defaultValue: "all" },
  ]);

  const filterBy = filterValues.type || "all";
  const filterByInstitution = filterValues.institution || "all";

  // Compute hasActiveFilters - always include all filters and search term
  const hasActiveFiltersComputed = hasActiveFilters || Boolean(searchTerm);

  // Clear all filters helper - exits hierarchical mode when clearing all
  const handleClearAllFilters = () => {
    setSearchTerm("");

    // If in hierarchical mode, navigate back to normal accounts page immediately
    if (isHierarchicalMode) {
      // Navigate first, clearAllFilters will be called by the normal accounts page
      navigate("/accounts", { replace: true });
    } else {
      // In normal mode, just clear filters
      clearAllFilters();
    }
  };

  const { data: accounts, isLoading } = trpc.accounts.getAll.useQuery();
  const { data: holdings } = trpc.holdings.getAll.useQuery();
  const { data: institutions } = trpc.institutions.getAll.useQuery();

  const { data: baseCurrency } = trpc.users.getBaseCurrency.useQuery();

  const { data: accountSummaries, isLoading: summariesLoading } =
    trpc.accounts.getSummaries.useQuery();
  const { data: accountTypes } = trpc.accountTypes.getAll.useQuery();

  // Determine if we're in hierarchical mode (accessed from institution)
  const isHierarchicalMode = Boolean(institutionId);
  const selectedInstitution = institutions?.find(
    (inst) => inst.id === institutionId
  );

  // Sync institution filter when navigating between routes
  useEffect(() => {
    if (institutionId && institutionId !== filterByInstitution) {
      // Set the institution filter to match the URL param
      updateFilter("institution", institutionId);
    } else if (!institutionId && filterByInstitution !== "all") {
      // Clear the institution filter when not in hierarchical mode
      updateFilter("institution", "all");
    }
  }, [institutionId, filterByInstitution, updateFilter]);

  // Handle institution filter changes with navigation
  const handleInstitutionFilterChange = (value: string) => {
    if (value === "all") {
      // User selected "All Institutions" - go to normal accounts page
      navigate("/accounts", { replace: true });
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

  const deleteAccount = trpc.accounts.delete.useMutation({
    onSuccess: (result) => {
      const { cascadeInfo } = result;
      let description = "The account has been successfully deleted.";

      if (cascadeInfo && cascadeInfo.holdingsDeleted > 0) {
        description += ` Also deleted: ${cascadeInfo.holdingsDeleted} holding${
          cascadeInfo.holdingsDeleted !== 1 ? "s" : ""
        }.`;
        // Note: Transaction deletions are hidden from UI but still happen in backend
      }

      toast({
        title: "Account deleted",
        description,
      });
      utils.accounts.getAll.invalidate();
      utils.accounts.getSummaries.invalidate();
      utils.holdings.getAll.invalidate();
      utils.holdings.getUnpriceableTokens.invalidate();
      utils.users.getPortfolioValue.invalidate();
      setIsDeleteDialogOpen(false);
      setAccountToDelete(null);
    },
    onError: (error) => {
      toast({
        title: "Error deleting account",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  // Create maps for quick lookups
  const institutionsMap = institutions
    ? Object.fromEntries(
        institutions.map((inst: ApiInstitution) => [inst.id, inst])
      )
    : {};

  // Filter accounts based on search term, type, and institution
  const filteredAccounts = displayAccounts.filter((account: ApiAccount) => {
    const matchesSearch =
      !searchTerm ||
      account.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      (account.type?.toLowerCase().includes(searchTerm.toLowerCase()) ??
        false) ||
      institutionsMap[account.institutionId]?.name
        .toLowerCase()
        .includes(searchTerm.toLowerCase());

    const matchesTypeFilter = filterBy === "all" || account.type === filterBy;
    const matchesInstitutionFilter =
      filterByInstitution === "all" ||
      account.institutionId === filterByInstitution;

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

  // Screenshot handlers

  const getAccountHoldings = (accountId: string) => {
    if (!holdings) return [];
    return holdings.filter(
      (holding: ApiHolding) => holding.accountId === accountId
    );
  };

  // Use backend-calculated account balances instead of manual calculations
  const getAccountBalance = (accountId: string): number => {
    if (!accountSummaries?.accounts) return 0;
    const accountSummary = accountSummaries.accounts.find(
      (acc) => acc.id === accountId
    );
    return accountSummary?.totalBalance ?? 0;
  };

  if (
    isLoading ||
    summariesLoading ||
    !holdings ||
    !institutions ||
    !accountSummaries
  ) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Accounts"
          subtitle="Manage your financial accounts"
          loading={true}
        />
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
    typeof accountSummaries?.totalBalance === "number"
      ? accountSummaries.totalBalance
      : parseFloat(accountSummaries?.totalBalance?.toString() || "0");
  const displayAccountsBalance = displayAccounts.reduce((total, account) => {
    const accountBalance = getAccountBalance(account.id);
    return total + accountBalance;
  }, 0);
  const filteredBalance = filteredAccounts.reduce((total, account) => {
    const accountBalance = getAccountBalance(account.id);
    return total + accountBalance;
  }, 0);

  const totalBalance = isHierarchicalMode
    ? displayAccountsBalance
    : allAccountsBalance;

  // Check if any accounts are affected by unpriceable tokens and should be highlighted
  const hasAffectedAccounts =
    shouldHighlight() &&
    baseAccounts.some((account) => {
      const institution = institutions.find(
        (inst) => inst.id === account.institutionId
      );
      return institution
        ? isAccountAffected(institution.name, account.name)
        : false;
    });

  const pageTitle =
    isHierarchicalMode && selectedInstitution
      ? `${selectedInstitution.name} Accounts`
      : "Your Accounts";

  const pageSubtitle = isHierarchicalMode
    ? `Accounts at ${selectedInstitution?.name || "this institution"}`
    : "Overview of your financial accounts with holdings";

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
            onValueChange={(value) => updateFilter("type", value)}
            accountTypes={[
              { id: "all", code: "all", name: "All Types" },
              ...(accountTypes || []),
            ]}
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
        <Card>
          <CardContent className="p-12 text-center">
            <Wallet className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold mb-2">No accounts yet</h3>
            <p className="text-muted-foreground mb-6 max-w-md mx-auto">
              You haven't added any holdings yet. When you create your first
              holding, the associated account will appear here automatically.
            </p>
            <p className="text-sm text-muted-foreground">
              Click the "Add Holding" button in the top right corner to get
              started.
            </p>
          </CardContent>
        </Card>
      ) : filteredAccounts.length === 0 ? (
        <Card>
          <CardContent className="p-12 text-center">
            <Wallet className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
            <div className="text-muted-foreground mb-4">
              {isHierarchicalMode
                ? `No accounts found for ${
                    selectedInstitution?.name || "this institution"
                  }.`
                : "No accounts match your search criteria."}
            </div>
            {!isHierarchicalMode && (
              <Button onClick={handleClearAllFilters}>Clear Filters</Button>
            )}
          </CardContent>
        </Card>
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
                  onDelete={() =>
                    handleDeleteAccount(account as unknown as Account)
                  }
                  onClick={
                    accountHoldings.length > 0
                      ? () => {
                          if (isHierarchicalMode) {
                            navigate(
                              `/institutions/${institutionId}/accounts/${account.id}`
                            );
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
              Are you sure you want to delete "{accountToDelete?.name}"? This
              action cannot be undone. All associated holdings will also be
              permanently deleted.
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
              {deleteAccount.isPending
                ? "Deleting..."
                : BUTTON_TEXT.DELETE_ACCOUNT}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
