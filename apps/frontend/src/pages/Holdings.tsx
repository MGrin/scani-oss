import { FinancialMath } from "@scani/shared";
import {
  Edit2,
  Eye,
  MoreHorizontal,
  PieChart,
  Plus,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { HoldingForm } from "@/components/HoldingForm";
import {
  AccountFilterSelector,
  TokenTypeSelector,
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MonetaryValue } from "@/components/ui/monetary-value";
import { PageAggregation } from "@/components/ui/page-aggregation";
import { PageHeader } from "@/components/ui/page-header";

import { ItemCard } from "@/components/ui/summary-cards";
import { useToast } from "@/hooks/use-toast";
import type {
  ApiAccount,
  ApiHolding,
  ApiInstitution,
  ApiToken,
} from "@/lib/api-types";
import { BUTTON_TEXT } from "@/lib/button-constants";
import { getTokenTypeIcon } from "@/lib/icons";
import { trpc } from "@/lib/trpc";

interface ProcessedHolding extends ApiHolding {
  token: ApiToken | undefined;
  account: ApiAccount | undefined;
  institution: ApiInstitution | null | undefined;
  value: number;
}

export function Holdings() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { institutionId, accountId } = useParams<{
    institutionId: string;
    accountId: string;
  }>();

  const { data: holdings, isLoading: holdingsLoading } =
    trpc.holdings.getAll.useQuery();
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

  const [searchTerm, setSearchTerm] = useState("");
  const [filterBy, setFilterBy] = useState<string>(
    searchParams.get("type") || "all"
  );
  const [filterByAccount, setFilterByAccount] = useState<string>(
    searchParams.get("account") || "all"
  );

  // Update filter when URL parameters change
  useEffect(() => {
    const typeParam = searchParams.get("type");
    if (typeParam) {
      setFilterBy(typeParam);
    }

    const accountParam = searchParams.get("account");
    if (accountParam) {
      setFilterByAccount(accountParam);
    }
  }, [searchParams]);

  // Handler to update filter state and sync with URL
  const handleFilterChange = (newFilter: string) => {
    setFilterBy(newFilter);
    const newSearchParams = new URLSearchParams(searchParams);
    if (newFilter === "all") {
      newSearchParams.delete("type");
    } else {
      newSearchParams.set("type", newFilter);
    }
    setSearchParams(newSearchParams);
  };

  // Handler to update account filter state and sync with URL
  const handleAccountFilterChange = (newFilter: string) => {
    setFilterByAccount(newFilter);
    const newSearchParams = new URLSearchParams(searchParams);
    if (newFilter === "all") {
      newSearchParams.delete("account");
    } else {
      newSearchParams.set("account", newFilter);
    }
    setSearchParams(newSearchParams);
  };
  const [isHoldingFormOpen, setIsHoldingFormOpen] = useState(false);
  const [holdingToEdit, setHoldingToEdit] = useState<ApiHolding | undefined>();
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [holdingToDelete, setHoldingToDelete] = useState<
    ProcessedHolding | undefined
  >();
  const [isViewDialogOpen, setIsViewDialogOpen] = useState(false);
  const [holdingToView, setHoldingToView] = useState<
    ProcessedHolding | undefined
  >();

  const utils = trpc.useUtils();
  const { toast } = useToast();

  const deleteHolding = trpc.holdings.delete.useMutation({
    onSuccess: () => {
      toast({
        title: "Success",
        description: `Holding for "${
          holdingToDelete?.token?.symbol || "token"
        }" has been deleted successfully.`,
        variant: "success",
      });
      utils.holdings.getAll.invalidate();
      setIsDeleteDialogOpen(false);
      setHoldingToDelete(undefined);
    },
    onError: (error) => {
      toast({
        title: "Error",
        description:
          error.message || "Failed to delete holding. Please try again.",
        variant: "destructive",
      });
    },
  });

  // Create maps for quick lookups
  const tokensMap = tokens
    ? Object.fromEntries(tokens.map((token: ApiToken) => [token.id, token]))
    : {};
  const accountsMap = accounts
    ? Object.fromEntries(
        accounts.map((account: ApiAccount) => [account.id, account])
      )
    : {};
  const institutionsMap = institutions
    ? Object.fromEntries(
        institutions.map((inst: ApiInstitution) => [inst.id, inst])
      )
    : {};

  // Process holdings with portfolio values and related data
  const processedHoldings: ProcessedHolding[] = displayHoldings.map(
    (holding: ApiHolding) => {
      const token = tokensMap[holding.tokenId];
      const account = accountsMap[holding.accountId];
      const institution = account
        ? institutionsMap[account.institutionId]
        : null;

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
    }
  );

  // Apply filters and search
  const filteredHoldings = processedHoldings.filter(
    (holding: ProcessedHolding) => {
      const matchesSearch =
        !searchTerm ||
        holding.token?.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        holding.token?.symbol
          .toLowerCase()
          .includes(searchTerm.toLowerCase()) ||
        holding.account?.name.toLowerCase().includes(searchTerm.toLowerCase());

      const matchesTypeFilter =
        filterBy === "all" || holding.token?.type === filterBy;
      const matchesAccountFilter =
        filterByAccount === "all" || holding.accountId === filterByAccount;

      return matchesSearch && matchesTypeFilter && matchesAccountFilter;
    }
  );

  // Sort by balance (highest to lowest) by default
  const sortedHoldings = [...filteredHoldings].sort((a, b) => {
    return b.value - a.value; // Descending order by value
  });

  const handleAddHolding = () => {
    navigate("/quick-add-holding");
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

  if (
    holdingsLoading ||
    portfolioLoading ||
    !tokens ||
    !accounts ||
    !institutions
  ) {
    return (
      <div className="space-y-4">
        <PageHeader
          title="Holdings"
          subtitle="Manage your investment positions"
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

  // Calculate totals
  const totalValue = processedHoldings.reduce(
    (sum, holding) => sum + holding.value,
    0
  );
  const filteredValue = filteredHoldings.reduce(
    (sum, holding) => sum + holding.value,
    0
  );

  const pageTitle =
    isHierarchicalMode && selectedAccount
      ? `${selectedAccount.name} Holdings`
      : "Holdings";

  const pageSubtitle =
    isHierarchicalMode && selectedAccount
      ? `Holdings in ${selectedAccount.name}`
      : "Manage your investment positions";

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
        totalCount={processedHoldings.length}
        filteredCount={filteredHoldings.length}
        entityLabel="holdings"
        totalBalance={totalValue}
        filteredBalance={filteredValue}
        baseCurrency={userPrefs?.baseCurrency?.symbol}
        searchTerm={searchTerm}
        onSearchChange={setSearchTerm}
        searchPlaceholder="Search holdings by token name, symbol, or account..."
        customFilter={
          <div className="flex gap-2">
            <div className="md:w-64">
              <TokenTypeSelector
                value={filterBy}
                onValueChange={handleFilterChange}
                tokenTypes={[
                  { id: "all", code: "all", name: "All Types" },
                  ...(tokenTypes || []),
                ]}
                placeholder="Filter by type..."
              />
            </div>
            {!isHierarchicalMode && (
              <div className="md:w-64">
                <AccountFilterSelector
                  value={filterByAccount}
                  onValueChange={handleAccountFilterChange}
                  accounts={accounts}
                  placeholder="Filter by account..."
                />
              </div>
            )}
          </div>
        }
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
            <div className="text-muted-foreground mb-4">
              No holdings match your search criteria
            </div>
            <Button
              onClick={() => {
                setSearchTerm("");
                setFilterBy("all");
                setFilterByAccount("all");
                // Clear URL params too
                navigate(
                  isHierarchicalMode
                    ? `/institutions/${institutionId}/accounts/${accountId}/holdings`
                    : "/holdings"
                );
              }}
            >
              Clear Filters
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {sortedHoldings.map((holding) => {
            const TypeIcon = getTokenTypeIcon(holding.token?.type ?? "");

            return (
              <ItemCard
                key={holding.id}
                title={holding.token?.name || "Unknown Token"}
                subtitle={
                  <>
                    <div className="flex items-center space-x-2 mb-1">
                      <span className="text-xs px-1.5 py-0.5 bg-muted rounded capitalize">
                        {holding.token?.type ?? "N/A"}
                      </span>
                    </div>
                    <div className="flex items-center space-x-1 text-xs text-muted-foreground">
                      <span>{holding.account?.name || "Unknown Account"}</span>
                      <span>•</span>
                      <span>
                        {holding.institution?.name || "Unknown Institution"}
                      </span>
                      <span>•</span>
                      <span>
                        Updated{" "}
                        {new Date(holding.lastUpdated).toLocaleDateString()}
                      </span>
                    </div>
                  </>
                }
                currencyValue={holding.value}
                currency={userPrefs?.baseCurrency?.symbol}
                tokenValue={parseFloat(holding.balance)}
                tokenSymbol={holding.token?.symbol}
                tokenDecimals={holding.token?.decimals}
                onClick={() => {
                  const account = accounts?.find(
                    (acc) => acc.id === holding.accountId
                  );
                  if (account) {
                    navigate(
                      `/institutions/${account.institutionId}/accounts/${account.id}/holdings/${holding.id}`
                    );
                  } else {
                    // Fallback to old route if account not found
                    navigate(`/transactions?holding=${holding.id}`);
                  }
                }}
                icon={
                  <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
                    <div className="text-center">
                      <div className="text-xs font-medium">
                        {holding.token?.symbol || "?"}
                      </div>
                      <TypeIcon className="h-2.5 w-2.5 mx-auto mt-0.5" />
                    </div>
                  </div>
                }
                actions={
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="sm">
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onClick={() =>
                          handleViewHolding(
                            holding as unknown as ProcessedHolding
                          )
                        }
                      >
                        <Eye className="h-4 w-4 mr-2" />
                        View Details
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() =>
                          handleEditHolding(
                            holding as unknown as ProcessedHolding
                          )
                        }
                      >
                        <Edit2 className="h-4 w-4 mr-2" />
                        {BUTTON_TEXT.EDIT_HOLDING}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() =>
                          handleDeleteHolding(
                            holding as unknown as ProcessedHolding
                          )
                        }
                        className="text-destructive"
                      >
                        <Trash2 className="h-4 w-4 mr-2" />
                        {BUTTON_TEXT.DELETE_HOLDING}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                }
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
        mode={holdingToEdit ? "edit" : "create"}
      />

      {/* View Holding Details Dialog */}
      <Dialog open={isViewDialogOpen} onOpenChange={setIsViewDialogOpen}>
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
                    currency={userPrefs?.baseCurrency?.symbol}
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
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Holding</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this holding for "
              {holdingToDelete?.token?.name}"? This action cannot be undone and
              will permanently remove the holding record and all associated
              transactions.
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
              {deleteHolding.isPending
                ? "Deleting..."
                : BUTTON_TEXT.DELETE_HOLDING}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
