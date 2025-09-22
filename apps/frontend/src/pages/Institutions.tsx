import { Building2 } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { InstitutionRow } from "@/components/InstitutionRow";

import { InstitutionTypeSelector } from "@/components/selectors/SearchableSelectors";
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
import { LoadingSpinner } from "@/components/ui/loading";
import { PageAggregation } from "@/components/ui/page-aggregation";
import { PageHeader } from "@/components/ui/page-header";
import { useUnpriceableTokens } from "@/contexts/UnpriceableTokensContext";
import { useToast } from "@/hooks/use-toast";
import { useFilters } from "@/hooks/useFilters";
import type { ApiInstitution, ApiToken } from "@/lib/api-types";

import { trpc } from "@/lib/trpc";

export function Institutions() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { isInstitutionAffected, shouldHighlight } = useUnpriceableTokens();

  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [institutionToDelete, setInstitutionToDelete] =
    useState<ApiInstitution | null>(null);

  // Screenshot handlers

  const {
    filters: filterValues,
    updateFilter,
    clearAllFilters,
  } = useFilters([
    { key: "search", defaultValue: "" },
    { key: "type", defaultValue: "all" },
  ]);

  const { data: institutions, isLoading } =
    trpc.institutions.getByUserId.useQuery();
  const { data: institutionTypes } = trpc.institutionTypes.getAll.useQuery();
  const { data: accounts } = trpc.accounts.getAll.useQuery();

  const { data: portfolioValue } = trpc.users.getPortfolioValue.useQuery();
  const { data: holdings } = trpc.holdings.getAll.useQuery();
  const { data: tokens } = trpc.tokens.getByUserId.useQuery();
  const { data: baseCurrency } = trpc.users.getBaseCurrency.useQuery();

  // Get trpc context for invalidating queries
  const trpcContext = trpc.useContext();

  // Delete mutation
  const deleteInstitutionMutation = trpc.institutions.delete.useMutation({
    onSuccess: (result) => {
      toast({
        title: "Accounts removed from institution",
        description: `Successfully removed your ${result.cascadeInfo.accountsDeleted} account(s) from "${result.deleted.name}". Also deleted ${result.cascadeInfo.holdingsDeleted} holding(s).`,
        // Note: Transactions are also deleted in backend but not mentioned in UI
      });
      // Refetch data to update UI
      void trpcContext.institutions.getByUserId.invalidate();
      void trpcContext.accounts.getAll.invalidate();
      void trpcContext.accounts.getSummaries.invalidate();
      void trpcContext.holdings.getAll.invalidate();
      void trpcContext.holdings.getUnpriceableTokens.invalidate();
      void trpcContext.users.getPortfolioValue.invalidate();
      // Close dialog and clear state
      setIsDeleteDialogOpen(false);
      setInstitutionToDelete(null);
    },
    onError: (error) => {
      toast({
        title: "Error",
        description:
          error.message || "Failed to remove accounts from institution",
        variant: "destructive",
      });
    },
  });

  // Delete handler
  const handleDeleteInstitution = (institution: ApiInstitution) => {
    setInstitutionToDelete(institution);
    setIsDeleteDialogOpen(true);
  };

  const confirmDeleteInstitution = () => {
    if (institutionToDelete) {
      deleteInstitutionMutation.mutate({ id: institutionToDelete.id });
    }
  };

  // Filter institutions based on search and type
  const filteredInstitutions =
    institutions?.filter((institution: ApiInstitution) => {
      const matchesSearch =
        !(filterValues.search || "") ||
        institution.name
          .toLowerCase()
          .includes((filterValues.search || "").toLowerCase()) ||
        institution.description
          ?.toLowerCase()
          .includes((filterValues.search || "").toLowerCase());

      const matchesFilter =
        (filterValues.type || "all") === "all" ||
        institution.type === (filterValues.type || "all");

      return matchesSearch && matchesFilter;
    }) || [];

  // Create tokens map for lookups
  const tokensMap = tokens
    ? Object.fromEntries(tokens.map((token: ApiToken) => [token.id, token]))
    : {};

  // Calculate institution balances and totals using portfolio value (base currency converted)
  const getInstitutionBalance = (institutionId: string): number => {
    if (!accounts || !portfolioValue?.holdings || !holdings || !tokens)
      return 0;

    // Get accounts for this institution
    const institutionAccounts = accounts.filter(
      (acc) => acc.institutionId === institutionId
    );

    // Sum up holdings values for accounts in this institution
    return institutionAccounts.reduce((total, account) => {
      // Find holdings that belong to this account
      const accountHoldings = holdings.filter(
        (holding) => holding.accountId === account.id
      );

      // Sum up the converted values for these holdings
      const accountTotal = accountHoldings.reduce((accSum, holding) => {
        // Get token info for this holding
        const token = tokensMap[holding.tokenId];
        if (!token) return accSum;

        // Find the corresponding portfolio holding with converted value
        const portfolioHolding = portfolioValue.holdings.find(
          (ph) => ph.tokenSymbol === token.symbol
        );

        if (portfolioHolding?.value && portfolioHolding?.balance) {
          // Calculate this individual holding's value based on its balance proportion
          const holdingBalance = parseFloat(holding.balance || "0");
          const totalTokenBalance = parseFloat(portfolioHolding.balance);
          const totalTokenValue = parseFloat(portfolioHolding.value);

          if (totalTokenBalance > 0) {
            // Calculate proportional value for this specific holding
            const individualValue =
              (holdingBalance / totalTokenBalance) * totalTokenValue;
            return accSum + individualValue;
          }
        }
        return accSum;
      }, 0);

      return total + accountTotal;
    }, 0);
  };

  // Use portfolio total value (already in base currency)
  const totalBalance = portfolioValue
    ? typeof portfolioValue.totalValue === "string"
      ? parseFloat(portfolioValue.totalValue)
      : portfolioValue.totalValue
    : 0;
  const filteredBalance = filteredInstitutions.reduce(
    (total, inst) => total + getInstitutionBalance(inst.id),
    0
  );

  // Check if any institutions are affected by unpriceable tokens and should be highlighted
  const hasAffectedInstitutions =
    shouldHighlight() &&
    (institutions?.some((institution) =>
      isInstitutionAffected(institution.name)
    ) ||
      false);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <PageHeader
          title="Your Financial Institutions"
          subtitle="Overview of institutions where you have accounts"
          loading={true}
        />
        <div className="flex items-center justify-center py-12">
          <div className="flex flex-col items-center gap-3">
            <LoadingSpinner size="lg" />
            <p className="text-muted-foreground">Loading institutions...</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Your Financial Institutions"
        subtitle="Overview of institutions where you have accounts"
      />

      <PageAggregation
        totalCount={institutions?.length || 0}
        filteredCount={filteredInstitutions.length}
        entityLabel="institutions"
        totalBalance={totalBalance}
        filteredBalance={filteredBalance}
        baseCurrency={baseCurrency?.symbol}
        searchTerm={filterValues.search || ""}
        onSearchChange={(value) => updateFilter("search", value)}
        searchPlaceholder="Search institutions by name, type, or description..."
        hasActiveFilters={
          (filterValues.search || "") !== "" ||
          (filterValues.type || "all") !== "all"
        }
        onClearFilters={clearAllFilters}
        isAffectedByUnpriceableTokens={hasAffectedInstitutions}
        filters={[
          <InstitutionTypeSelector
            key="type"
            value={filterValues.type || "all"}
            onValueChange={(value) => updateFilter("type", value)}
            institutionTypes={[
              { id: "all", code: "all", name: "All Types" },
              ...(institutionTypes || []),
            ]}
            placeholder="Filter by type..."
          />,
        ]}
      />

      {!institutions || institutions.length === 0 ? (
        <Card>
          <CardContent className="p-12 text-center">
            <Building2 className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold mb-2">No institutions yet</h3>
            <p className="text-muted-foreground mb-6 max-w-md mx-auto">
              You haven't added any holdings yet. When you create your first
              holding, the associated institution will appear here
              automatically.
            </p>
            <p className="text-sm text-muted-foreground">
              Click the "Add Holding" button in the top right corner to get
              started.
            </p>
          </CardContent>
        </Card>
      ) : filteredInstitutions.length === 0 ? (
        <Card>
          <CardContent className="p-12 text-center">
            <div className="text-muted-foreground mb-4">
              No institutions match your search criteria
            </div>
            <Button onClick={clearAllFilters}>Clear Filters</Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {filteredInstitutions.map((institution: ApiInstitution) => {
            const balance = getInstitutionBalance(institution.id);
            const accountCount =
              accounts?.filter((acc) => acc.institutionId === institution.id)
                .length || 0;

            return (
              <InstitutionRow
                key={institution.id}
                institution={{
                  ...institution,
                  balance,
                  accountCount,
                }}
                userPrefs={{
                  baseCurrency: baseCurrency || undefined,
                }}
                onDelete={handleDeleteInstitution}
                onClick={() => navigate(`/institutions/${institution.id}`)}
              />
            );
          })}
        </div>
      )}

      {/* Delete Confirmation Dialog */}
      <Dialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove Accounts from Institution</DialogTitle>
            <DialogDescription>
              Are you sure you want to remove all your accounts from "
              {institutionToDelete?.name}"? This will delete all your accounts
              and holdings associated with this institution. This action cannot
              be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setIsDeleteDialogOpen(false)}
              disabled={deleteInstitutionMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={confirmDeleteInstitution}
              disabled={deleteInstitutionMutation.isPending}
            >
              {deleteInstitutionMutation.isPending
                ? "Removing..."
                : "Remove My Accounts"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
