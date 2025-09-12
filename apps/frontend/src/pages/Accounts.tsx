import { type Account, FinancialMath } from "@scani/shared";
import {
  ChevronDown,
  ChevronUp,
  MoreHorizontal,
  Plus,
  Search,
  Trash2,
  Wallet,
} from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { useToast } from "@/hooks/use-toast";
import type {
  ApiAccount,
  ApiHolding,
  ApiInstitution,
  ApiToken,
} from "@/lib/api-types";
import { BUTTON_TEXT } from "@/lib/button-constants";
import { getAccountTypeIcon } from "@/lib/icons";
import { trpc } from "@/lib/trpc";

export function Accounts() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [searchTerm, setSearchTerm] = useState("");
  const [accountToDelete, setAccountToDelete] = useState<Account | null>(null);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const [expandedAccounts, setExpandedAccounts] = useState<Set<string>>(
    new Set()
  );

  const { data: accounts, isLoading } = trpc.accounts.getAll.useQuery();
  const { data: holdings } = trpc.holdings.getAll.useQuery();
  const { data: institutions } = trpc.institutions.getAll.useQuery();
  const { data: tokens } = trpc.tokens.getAll.useQuery();
  const { data: accountTypes } = trpc.accountTypes.getAll.useQuery();

  const utils = trpc.useUtils();

  const deleteAccount = trpc.accounts.delete.useMutation({
    onSuccess: (result) => {
      const { cascadeInfo } = result;
      let description = "The account has been successfully deleted.";

      if (
        cascadeInfo &&
        (cascadeInfo.holdingsDeleted > 0 || cascadeInfo.transactionsDeleted > 0)
      ) {
        const parts = [];
        if (cascadeInfo.holdingsDeleted > 0) {
          parts.push(
            `${cascadeInfo.holdingsDeleted} holding${
              cascadeInfo.holdingsDeleted !== 1 ? "s" : ""
            }`
          );
        }
        if (cascadeInfo.transactionsDeleted > 0) {
          parts.push(
            `${cascadeInfo.transactionsDeleted} transaction${
              cascadeInfo.transactionsDeleted !== 1 ? "s" : ""
            }`
          );
        }
        description += ` Also deleted: ${parts.join(" and ")}.`;
      }

      toast({
        title: "Account deleted",
        description,
      });
      utils.accounts.getAll.invalidate();
      utils.holdings.getAll.invalidate();
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
  const tokensMap = tokens
    ? Object.fromEntries(tokens.map((token: ApiToken) => [token.id, token]))
    : {};

  // Filter accounts based on search term
  const filteredAccounts =
    accounts?.filter((account: ApiAccount) => {
      if (!searchTerm) return true;
      const searchLower = searchTerm.toLowerCase();
      const institution = institutionsMap[account.institutionId];
      return (
        account.name.toLowerCase().includes(searchLower) ||
        (account.type?.toLowerCase().includes(searchLower) ?? false) ||
        institution?.name.toLowerCase().includes(searchLower)
      );
    }) || [];

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

  const toggleAccountExpansion = (accountId: string) => {
    const newExpanded = new Set(expandedAccounts);
    if (newExpanded.has(accountId)) {
      newExpanded.delete(accountId);
    } else {
      newExpanded.add(accountId);
    }
    setExpandedAccounts(newExpanded);
  };

  const getAccountHoldings = (accountId: string) => {
    if (!holdings) return [];
    return holdings.filter(
      (holding: ApiHolding) => holding.accountId === accountId
    );
  };

  // Calculate account balances from holdings using precise decimal math
  const getAccountBalance = (accountId: string): number => {
    if (!holdings) return 0;
    const accountHoldings = holdings.filter(
      (holding: ApiHolding) => holding.accountId === accountId
    );
    return FinancialMath.toNumber(
      FinancialMath.sum(
        accountHoldings.map((holding: ApiHolding) => holding.balance)
      )
    );
  };

  if (isLoading || !holdings || !institutions || !tokens) {
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

  const totalBalance = filteredAccounts
    ? FinancialMath.toNumber(
        FinancialMath.sum(
          filteredAccounts.map((account: ApiAccount) =>
            getAccountBalance(account.id)
          )
        )
      )
    : 0;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Your Accounts"
        subtitle="Overview of your financial accounts with holdings"
        primaryAction={{
          label: "Add Holding",
          onClick: () => navigate("/quick-add-holding"),
          icon: <Plus className="h-4 w-4 mr-1" />,
        }}
      />

      {/* Search Bar */}
      {accounts && accounts.length > 0 && (
        <Card>
          <CardContent className="p-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search accounts by name, type, institution, or account number..."
                className="pl-10 h-9 text-sm"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
            </div>
            {searchTerm && (
              <p className="text-xs text-muted-foreground mt-2">
                {filteredAccounts.length} of {accounts.length} accounts match
                your search
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Summary Card */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            {searchTerm
              ? `Search Results (${filteredAccounts.length})`
              : "Account Summary"}
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <p className="text-xs text-muted-foreground">Total Balance</p>
              <p className="text-lg font-bold">
                {FinancialMath.formatCurrency(totalBalance)}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">
                {searchTerm ? "Matching Accounts" : "Total Accounts"}
              </p>
              <p className="text-lg font-bold">
                {searchTerm ? filteredAccounts.length : accounts?.length || 0}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Accounts Grid */}
      {!accounts || accounts.length === 0 ? (
        <Card>
          <CardContent className="p-12 text-center">
            <Wallet className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold mb-2">No accounts yet</h3>
            <p className="text-muted-foreground mb-6 max-w-md mx-auto">
              You haven't added any holdings yet. When you create your first
              holding, the associated account will appear here automatically.
            </p>
            <Button onClick={() => navigate("/quick-add-holding")}>
              <Plus className="h-4 w-4 mr-2" />
              Create Your First Holding
            </Button>
          </CardContent>
        </Card>
      ) : filteredAccounts.length === 0 ? (
        <Card>
          <CardContent className="p-12 text-center">
            <div className="text-muted-foreground mb-4">
              No accounts match your search criteria
            </div>
            <Button onClick={() => setSearchTerm("")}>Clear Search</Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {filteredAccounts.map((account: ApiAccount) => {
            const IconComponent = getAccountTypeIcon(account.type ?? "other");
            const accountBalance = getAccountBalance(account.id);
            const institution = institutionsMap[account.institutionId];
            const accountHoldings = getAccountHoldings(account.id);
            const isExpanded = expandedAccounts.has(account.id);

            return (
              <Card
                key={account.id}
                className="hover:shadow-md transition-shadow"
              >
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-2">
                      {IconComponent && (
                        <IconComponent className="h-4 w-4 text-muted-foreground" />
                      )}
                      <div>
                        <CardTitle className="text-base">
                          {account.name}
                        </CardTitle>
                        <p className="text-xs text-muted-foreground">
                          {institution?.name || "Unknown Institution"}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center space-x-3">
                      <div className="text-right">
                        <p className="text-lg font-bold">
                          {FinancialMath.formatCurrency(accountBalance)}
                        </p>
                        <p className="text-xs text-muted-foreground capitalize">
                          {account.type?.replace("_", " ") ?? "Unknown Type"}
                        </p>
                      </div>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="sm">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onClick={() =>
                              handleDeleteAccount(account as unknown as Account)
                            }
                            className="text-destructive"
                          >
                            <Trash2 className="h-4 w-4 mr-2" />
                            {BUTTON_TEXT.DELETE_ACCOUNT}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="pt-2">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center space-x-2 text-xs text-muted-foreground">
                        <span>{accountHoldings.length} holdings</span>
                        <span>•</span>
                        <span>
                          Updated{" "}
                          {new Date(account.updatedAt).toLocaleDateString()}
                        </span>
                      </div>
                      {accountHoldings.length > 0 && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => toggleAccountExpansion(account.id)}
                        >
                          {isExpanded ? (
                            <ChevronUp className="h-4 w-4" />
                          ) : (
                            <ChevronDown className="h-4 w-4" />
                          )}
                          {isExpanded ? "Hide" : "Show"} Holdings
                        </Button>
                      )}
                    </div>

                    {/* Holdings breakdown */}
                    {isExpanded && accountHoldings.length > 0 && (
                      <div className="border-t pt-2">
                        <h4 className="font-semibold text-xs mb-2 text-muted-foreground uppercase tracking-wide">
                          Holdings Breakdown
                        </h4>
                        <div className="space-y-1.5">
                          {accountHoldings.map((holding: ApiHolding) => {
                            const token = tokensMap[holding.tokenId];
                            const holdingValue = FinancialMath.abs(
                              holding.balance ?? 0
                            );

                            return (
                              <div
                                key={holding.id}
                                className="flex items-center justify-between py-1.5 px-2 bg-muted/30 rounded"
                              >
                                <div className="flex items-center space-x-2">
                                  <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center">
                                    <span className="text-xs font-medium">
                                      {token?.symbol || "?"}
                                    </span>
                                  </div>
                                  <div>
                                    <p className="font-medium text-xs">
                                      {token?.name || "Unknown Token"}
                                    </p>
                                    <p className="text-xs text-muted-foreground capitalize">
                                      {token?.type ?? "N/A"}
                                    </p>
                                  </div>
                                </div>
                                <div className="text-right">
                                  <p className="font-semibold text-sm">
                                    {FinancialMath.formatCurrency(holdingValue)}
                                  </p>
                                  <p className="text-xs text-muted-foreground">
                                    {parseFloat(holding.balance ?? "0").toFixed(
                                      token?.decimals || 2
                                    )}{" "}
                                    {token?.symbol || ""}
                                  </p>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
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
              {accountTypes?.map((accountType) => {
                const typeAccounts = accounts.filter(
                  (acc: ApiAccount) => acc.type === accountType.code
                );
                const typeBalance = FinancialMath.toNumber(
                  FinancialMath.sum(
                    typeAccounts.map((acc: ApiAccount) =>
                      getAccountBalance(acc.id)
                    )
                  )
                );

                if (typeAccounts.length === 0) return null;

                const IconComponent = getAccountTypeIcon(accountType.code);

                return (
                  <div
                    key={accountType.code}
                    className="flex items-center space-x-2"
                  >
                    <IconComponent className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <p className="font-medium text-sm">{accountType.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {typeAccounts.length} accounts •{" "}
                        {FinancialMath.formatCurrency(typeBalance)}
                      </p>
                    </div>
                  </div>
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
              Are you sure you want to delete "{accountToDelete?.name}"? This
              action cannot be undone. All associated holdings and transactions
              will also be permanently deleted.
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
