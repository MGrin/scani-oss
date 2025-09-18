import { Decimal, FinancialMath, type Holding } from "@scani/shared";
import {
  Camera,
  DollarSign,
  Plus,
  TrendingDown,
  TrendingUp,
  Wallet,
  Zap,
} from "lucide-react";
import { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import { HoldingRow } from "@/components/HoldingRow";
import { useUnpriceableTokens } from "@/contexts/UnpriceableTokensContext";

import {
  TRANSACTION_TYPE_METADATA,
  TransactionForm,
} from "@/components/TransactionForm";
import { TransactionRow } from "@/components/TransactionRow";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import { PageHeader } from "@/components/ui/page-header";
import { ItemCard, SummaryCard } from "@/components/ui/summary-cards";

import type { WebSocketMessage } from "@/hooks/useWebSocket";
import { useScaniWebSocket } from "@/hooks/useWebSocket";
import type { ApiHolding, ApiToken } from "@/lib/api-types";
import { getTokenTypeIcon } from "@/lib/icons";
import { trpc } from "@/lib/trpc";

export function Dashboard() {
  const navigate = useNavigate();
  const { shouldHighlight, hasUnpriceableTokensOfType } =
    useUnpriceableTokens();

  // State for Quick Actions modals
  const [isTransactionFormOpen, setIsTransactionFormOpen] = useState(false);
  // Screenshot upload handler
  const handleScreenshotFormOpen = () => navigate("/quick-add-holding");

  const { data: accounts, isLoading: accountsLoading } =
    trpc.accounts.getAll.useQuery();
  const { data: holdings, isLoading: holdingsLoading } =
    trpc.holdings.getAll.useQuery();
  const { data: transactions, isLoading: transactionsLoading } =
    trpc.transactions.getAll.useQuery();
  // Use optimized endpoints - only get tokens that user has holdings for
  const { data: tokens } = trpc.tokens.getByUserId.useQuery();

  const { data: baseCurrency } = trpc.users.getBaseCurrency.useQuery();

  const { data: portfolioValue, isLoading: portfolioLoading } =
    trpc.users.getPortfolioValue.useQuery();
  const { data: monthlySummary, isLoading: monthlySummaryLoading } =
    trpc.transactions.getMonthlySummary.useQuery({});

  const handleWebSocketMessage = useCallback((message: WebSocketMessage) => {
    console.log("Received WebSocket message:", message);
    // Handle real-time updates here if needed
  }, []);

  const { isConnected, connectionStatus } = useScaniWebSocket({
    url: "ws://localhost:3002",
    onMessage: handleWebSocketMessage,
  });

  // Create maps for quick lookups (using only tokens user has holdings for)
  const tokensMap = tokens
    ? Object.fromEntries(tokens.map((token: ApiToken) => [token.id, token]))
    : {};

  // Use portfolio value calculation instead of raw balance
  const totalHoldingsValue = portfolioValue
    ? parseFloat(portfolioValue.totalValue.toString())
    : 0;

  // Calculate holdings by token type
  interface TokenTypeData {
    count: number;
    totalValue: number;
    holdings: Holding[];
  }

  const holdingsByTokenType =
    holdings && portfolioValue
      ? holdings.reduce(
          (acc: Record<string, TokenTypeData>, holding: ApiHolding) => {
            const token = tokensMap[holding.tokenId];
            if (!token) return acc;

            const tokenType = token.type ?? "unknown";
            if (!acc[tokenType]) {
              acc[tokenType] = {
                count: 0,
                totalValue: 0,
                holdings: [],
              };
            }

            // Calculate individual holding value based on its proportion of total token balance
            let holdingValue = FinancialMath.toNumber(
              FinancialMath.abs(holding.balance ?? "0")
            ); // fallback to raw balance

            const portfolioHolding = portfolioValue.holdings.find(
              (ph) => ph.tokenSymbol === token.symbol
            );

            if (portfolioHolding?.value && portfolioHolding?.balance) {
              // Calculate this holding's proportion of the total token balance
              const holdingBalance = FinancialMath.toNumber(
                new Decimal(holding.balance ?? "0")
              );
              const totalTokenBalance = FinancialMath.toNumber(
                new Decimal(portfolioHolding.balance)
              );
              const totalTokenValue = parseFloat(portfolioHolding.value);

              if (totalTokenBalance > 0) {
                // Calculate proportional value for this specific holding
                holdingValue =
                  (holdingBalance / totalTokenBalance) * totalTokenValue;
              }
            }

            acc[tokenType].count += 1;
            acc[tokenType].totalValue = FinancialMath.toNumber(
              FinancialMath.add(acc[tokenType].totalValue, holdingValue)
            );
            acc[tokenType].holdings.push(holding as unknown as Holding);

            return acc;
          },
          {}
        )
      : {};

  // Get top 5 holdings by value using portfolio calculation
  const topHoldings =
    holdings && portfolioValue
      ? [...holdings]
          .map((holding) => {
            const token = tokensMap[holding.tokenId];
            // Calculate individual holding value based on its proportion of total token balance
            let value = FinancialMath.toNumber(
              FinancialMath.abs(holding.balance ?? "0")
            ); // fallback to raw balance

            const portfolioHolding = portfolioValue.holdings.find(
              (ph) => ph.tokenSymbol === token?.symbol
            );

            if (
              portfolioHolding?.value &&
              portfolioHolding?.balance &&
              token?.symbol
            ) {
              // Calculate this holding's proportion of the total token balance
              const holdingBalance = FinancialMath.toNumber(
                new Decimal(holding.balance ?? "0")
              );
              const totalTokenBalance = FinancialMath.toNumber(
                new Decimal(portfolioHolding.balance)
              );
              const totalTokenValue = parseFloat(portfolioHolding.value);

              if (totalTokenBalance > 0) {
                // Calculate proportional value for this specific holding
                value = (holdingBalance / totalTokenBalance) * totalTokenValue;
              }
            }

            return {
              ...holding,
              token,
              value,
            };
          })
          .sort((a, b) => b.value - a.value)
          .slice(0, 5)
      : [];

  const recentTransactions = transactions?.slice(0, 5) || [];

  // Use backend-calculated monthly summaries (now properly converted to base currency)
  const monthlyDeposits = monthlySummary?.totalDeposits ?? 0;
  const monthlyWithdrawals = monthlySummary?.totalWithdrawals ?? 0;

  // Transaction utility functions (shared with Transactions page)
  const getTransactionIcon = (type: string) => {
    // Use consistent icons from metadata
    const metadata = TRANSACTION_TYPE_METADATA[type];
    return metadata?.icon || "�"; // Default to the 'other' icon if not found
  };

  const getTransactionColor = (type: string) => {
    if (["deposit", "sell", "dividend", "interest"].includes(type)) {
      return "bg-green-500";
    } else if (["withdrawal", "buy"].includes(type)) {
      return "bg-red-500";
    }
    return "bg-blue-500";
  };

  if (
    transactionsLoading ||
    accountsLoading ||
    holdingsLoading ||
    portfolioLoading ||
    monthlySummaryLoading ||
    !tokens
  ) {
    return (
      <div className="space-y-4">
        <PageHeader
          title="Dashboard"
          subtitle="Your financial overview"
          loading={true}
          secondaryActions={
            <div className="text-sm text-muted-foreground">
              WebSocket: {connectionStatus}
            </div>
          }
        />

        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {[1, 2, 3, 4].map((i) => (
            <Card key={i}>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">
                  Loading...
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="h-6 bg-muted animate-pulse rounded"></div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Dashboard"
        subtitle="Your financial overview"
        secondaryActions={
          <div className="flex items-center space-x-1.5">
            <div
              className={`h-1.5 w-1.5 rounded-full ${
                isConnected ? "bg-green-500" : "bg-red-500"
              }`}
            />
            <span className="text-sm text-muted-foreground">
              {isConnected ? "Live" : "Offline"}
            </span>
          </div>
        }
      />

      {/* Stats Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard
          type="currency"
          title="Total Balance"
          value={totalHoldingsValue}
          currency={baseCurrency?.symbol}
          subtitle={`Across ${holdings?.length || 0} holdings in ${
            accounts?.length || 0
          } accounts`}
          icon={Wallet}
          isAffectedByUnpriceableTokens={shouldHighlight()}
        />

        <SummaryCard
          type="currency"
          title="Monthly Deposits"
          value={monthlyDeposits}
          currency={baseCurrency?.symbol}
          subtitle="This month"
          icon={TrendingUp}
          className="[&_.value]:text-green-600"
        />

        <SummaryCard
          type="currency"
          title="Monthly Withdrawals"
          value={monthlyWithdrawals}
          currency={baseCurrency?.symbol}
          subtitle="This month"
          icon={TrendingDown}
          className="[&_.value]:text-red-600"
        />

        <SummaryCard
          type="currency"
          title="Net Flow"
          value={FinancialMath.toNumber(
            FinancialMath.subtract(monthlyDeposits, monthlyWithdrawals)
          )}
          currency={baseCurrency?.symbol}
          subtitle="This month"
          icon={DollarSign}
          showSigned={true}
        />
      </div>

      {/* Quick Actions */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center space-x-2">
            <Plus className="h-5 w-5" />
            <span>Quick Actions</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Button
            onClick={() => navigate("/quick-add-holding")}
            className="flex items-center justify-center space-x-2 h-11 touch-manipulation"
          >
            <Zap className="h-5 w-5" />
            <span>Add Holding</span>
          </Button>
          <Button
            variant="outline"
            onClick={() => setIsTransactionFormOpen(true)}
            className="flex items-center justify-center space-x-2 h-11 touch-manipulation"
          >
            <DollarSign className="h-5 w-5" />
            <span>Add Transaction</span>
          </Button>
          <Button
            variant="outline"
            onClick={handleScreenshotFormOpen}
            className="flex items-center justify-center space-x-2 h-11 touch-manipulation"
          >
            <Camera className="h-5 w-5" />
            <span>Upload Screenshot</span>
          </Button>
        </CardContent>
      </Card>

      {/* Holdings Overview */}
      <div className="grid gap-4 lg:grid-cols-2">
        {/* Holdings by Token Type */}
        <Card>
          <CardHeader>
            <CardTitle>Holdings by Type</CardTitle>
          </CardHeader>
          <CardContent>
            {Object.keys(holdingsByTokenType).length === 0 ? (
              <div className="text-center py-6 text-muted-foreground">
                No holdings found
              </div>
            ) : (
              <div className="space-y-3">
                {Object.entries(holdingsByTokenType)
                  .sort(
                    ([, a], [, b]) =>
                      (b as TokenTypeData).totalValue -
                      (a as TokenTypeData).totalValue
                  )
                  .map(([tokenType, data]) => {
                    const tokenData = data as TokenTypeData;
                    const IconComponent = getTokenTypeIcon(tokenType);

                    return (
                      <ItemCard
                        key={tokenType}
                        title={
                          tokenType.charAt(0).toUpperCase() + tokenType.slice(1)
                        }
                        subtitle={
                          <div className="flex items-center space-x-1 text-xs text-muted-foreground">
                            <span>{tokenData.count} holdings</span>
                            <span>•</span>
                            <span>
                              {(
                                (tokenData.totalValue / totalHoldingsValue) *
                                100
                              ).toFixed(1)}
                              %
                            </span>
                          </div>
                        }
                        currencyValue={tokenData.totalValue}
                        currency={baseCurrency?.symbol}
                        onClick={() =>
                          navigate(
                            `/holdings?type=${encodeURIComponent(tokenType)}`
                          )
                        }
                        icon={
                          <IconComponent className="h-8 w-8 text-muted-foreground" />
                        }
                        isAffectedByUnpriceableTokens={
                          tokens
                            ? hasUnpriceableTokensOfType(tokenType, tokens)
                            : false
                        }
                      />
                    );
                  })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Top Holdings */}
        <Card>
          <CardHeader>
            <CardTitle>Top Holdings</CardTitle>
          </CardHeader>
          <CardContent>
            {topHoldings.length === 0 ? (
              <div className="text-center py-6 text-muted-foreground">
                No holdings found
              </div>
            ) : (
              <div className="space-y-3">
                {topHoldings.map((holding, index: number) => {
                  const account = accounts?.find(
                    (acc) => acc.id === holding.accountId
                  );

                  return (
                    <HoldingRow
                      key={holding.id}
                      holding={{
                        ...holding,
                        account,
                        institution: undefined, // Not available in Dashboard context
                      }}
                      userPrefs={{
                        baseCurrency: baseCurrency || undefined,
                      }}
                      showRank={true}
                      rank={index + 1}
                      onClick={() => {
                        if (account) {
                          navigate(
                            `/institutions/${account.institutionId}/accounts/${account.id}/holdings/${holding.id}`
                          );
                        } else {
                          // Fallback to old route if account not found
                          navigate(
                            `/transactions?holding=${encodeURIComponent(
                              holding.id
                            )}`
                          );
                        }
                      }}
                    />
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Recent Transactions</CardTitle>
        </CardHeader>
        <CardContent>
          {recentTransactions.length === 0 ? (
            <div className="text-center py-6 text-muted-foreground">
              No transactions yet. Create your first transaction to get started.
            </div>
          ) : (
            <div className="space-y-3">
              {recentTransactions.map((transaction) => {
                const holding = holdings?.find(
                  (h) => h.id === transaction.holdingId
                );
                const account = accounts?.find(
                  (acc) => acc.id === holding?.accountId
                );
                const token = tokensMap[holding?.tokenId || ""];

                return (
                  <TransactionRow
                    key={transaction.id}
                    transaction={transaction}
                    account={account}
                    token={token}
                    getTransactionColor={getTransactionColor}
                    getTransactionIcon={getTransactionIcon}
                  />
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
      <TransactionForm
        isOpen={isTransactionFormOpen}
        onClose={() => setIsTransactionFormOpen(false)}
        mode="create"
      />
    </div>
  );
}
