import { Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { PrivateTokenForm } from "@/components/PrivateTokenForm";
import { TokenTypeSelector } from "@/components/selectors/SearchableSelectors";
import { TokenRow } from "@/components/TokenRow";
import { UpdatePrivateTokenForm } from "@/components/UpdatePrivateTokenForm";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PageAggregation } from "@/components/ui/page-aggregation";
import { PageHeader } from "@/components/ui/page-header";
import { useUnpriceableTokens } from "@/contexts/UnpriceableTokensContext";
import { useFilters } from "@/hooks/useFilters";
import { trpc } from "@/lib/trpc";

export function Tokens() {
  const navigate = useNavigate();
  const { isTokenUnpriceable, shouldHighlight } = useUnpriceableTokens();
  const [isCreateFormOpen, setIsCreateFormOpen] = useState(false);
  const [isUpdateFormOpen, setIsUpdateFormOpen] = useState(false);
  const [selectedToken, setSelectedToken] = useState<{
    id: string;
    symbol: string;
    name: string;
    decimals: number;
    typeId: string;
  } | null>(null);
  const [searchTerm, setSearchTerm] = useState("");

  // Unified filter system
  const {
    filters: filterValues,
    updateFilter,
    clearAllFilters,
    hasActiveFilters,
  } = useFilters([{ key: "type", defaultValue: "all" }]);

  const filterBy = filterValues.type || "all";

  // Compute hasActiveFilters - always include all filters and search term
  const hasActiveFiltersComputed = hasActiveFilters || Boolean(searchTerm);

  // Clear all filters helper
  const handleClearAllFilters = () => {
    setSearchTerm("");
    clearAllFilters();
  };

  // Data queries - get tokens with their total values
  const { data: tokensWithValues, isLoading: tokensLoading } =
    trpc.tokens.getWithTotalValues.useQuery();
  const { data: tokenTypes } = trpc.tokenTypes.getAll.useQuery();
  const { data: userPrefs } = trpc.users.getCurrent.useQuery();
  const { data: tokens } = trpc.tokens.getAll.useQuery();

  // Find user's base currency from tokens
  const baseCurrency = useMemo(() => {
    if (!userPrefs?.baseCurrencyId || !tokens) return null;
    return (
      tokens.find((token) => token.id === userPrefs.baseCurrencyId) || null
    );
  }, [userPrefs?.baseCurrencyId, tokens]);

  const utils = trpc.useUtils();

  // Filter tokens based on search term and type
  const filteredTokens =
    tokensWithValues?.filter((token) => {
      const matchesSearch =
        !searchTerm ||
        token.symbol.toLowerCase().includes(searchTerm.toLowerCase()) ||
        token.name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        token.typeName?.toLowerCase().includes(searchTerm.toLowerCase());

      const matchesFilter = filterBy === "all" || token.type === filterBy;

      return matchesSearch && matchesFilter;
    }) || [];

  // Check if token is private (editable)
  const isPrivateToken = (typeCode: string) => {
    return typeCode === "private-company" || typeCode === "other";
  };

  // Calculate totals
  const totalValue =
    tokensWithValues?.reduce((sum, token) => {
      return sum + parseFloat(token.totalValueInBaseCurrency);
    }, 0) || 0;

  const filteredValue = filteredTokens.reduce((sum, token) => {
    return sum + parseFloat(token.totalValueInBaseCurrency);
  }, 0);

  // Check if any tokens are unpriceable and should be highlighted
  const hasUnpriceableTokens =
    shouldHighlight() &&
    (tokensWithValues?.some((token) => isTokenUnpriceable(token.symbol)) ||
      false);

  if (tokensLoading || !userPrefs) {
    return (
      <div className="space-y-4">
        <PageHeader
          title="Tokens"
          subtitle="Manage tokens you currently hold in your portfolio"
          loading={true}
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header with CTA aligned to title */}
      <PageHeader
        title="Tokens"
        subtitle="Manage tokens you currently hold in your portfolio"
        primaryAction={{
          label: "Add Token",
          onClick: () => setIsCreateFormOpen(true),
          icon: <Plus className="h-4 w-4 mr-1" />,
        }}
      />

      {/* Search and Filter */}
      <PageAggregation
        totalCount={tokensWithValues?.length || 0}
        filteredCount={filteredTokens.length}
        entityLabel="tokens"
        totalBalance={totalValue}
        filteredBalance={filteredValue}
        baseCurrency={baseCurrency?.symbol}
        searchTerm={searchTerm}
        onSearchChange={setSearchTerm}
        searchPlaceholder="Search tokens by symbol, name, or type..."
        hasActiveFilters={hasActiveFiltersComputed}
        onClearFilters={handleClearAllFilters}
        filters={[
          <TokenTypeSelector
            key="type"
            value={filterBy}
            onValueChange={(value) => updateFilter("type", value)}
            tokenTypes={[
              { id: "all", code: "all", name: "All Types" },
              ...(tokenTypes || []),
            ]}
            placeholder="Filter by type..."
          />,
        ]}
        isAffectedByUnpriceableTokens={hasUnpriceableTokens}
      />

      {/* Tokens List */}
      {!filteredTokens.length ? (
        <Card>
          <CardContent className="p-12 text-center">
            <div className="text-muted-foreground mb-4">No tokens found</div>
            <Button onClick={() => setIsCreateFormOpen(true)}>
              <Plus className="h-4 w-4 mr-2" />
              Add Your First Token
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {filteredTokens.map((token) => {
            return (
              <TokenRow
                key={token.id}
                token={token}
                isEditable={isPrivateToken(token.type || "")}
                onEdit={() => {
                  setSelectedToken({
                    id: token.id,
                    symbol: token.symbol,
                    name: token.name || "",
                    decimals: token.decimals,
                    typeId: token.typeId || "",
                  });
                  setIsUpdateFormOpen(true);
                }}
                onClick={() => {
                  navigate(`/holdings?token=${token.id}`);
                }}
              />
            );
          })}
        </div>
      )}

      {/* Token Creation Dialog */}
      <PrivateTokenForm
        isOpen={isCreateFormOpen}
        onClose={() => setIsCreateFormOpen(false)}
        mode="create"
        token={null}
        onSuccess={() => {
          utils.tokens.getWithTotalValues.invalidate();
          setIsCreateFormOpen(false);
        }}
      />

      {/* Token Update Dialog */}
      <UpdatePrivateTokenForm
        isOpen={isUpdateFormOpen}
        onClose={() => {
          setIsUpdateFormOpen(false);
          setSelectedToken(null);
        }}
        token={selectedToken}
        onSuccess={() => {
          utils.tokens.getWithTotalValues.invalidate();
          setIsUpdateFormOpen(false);
          setSelectedToken(null);
        }}
      />
    </div>
  );
}
