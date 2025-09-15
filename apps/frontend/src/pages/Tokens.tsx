import { Edit, MoreHorizontal, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PrivateTokenForm } from '@/components/PrivateTokenForm';
import { TokenTypeSelector } from '@/components/selectors/SearchableSelectors';
import { UpdatePrivateTokenForm } from '@/components/UpdatePrivateTokenForm';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { PageAggregation } from '@/components/ui/page-aggregation';
import { PageHeader } from '@/components/ui/page-header';
import { ItemCard } from '@/components/ui/summary-cards';
import { getTokenTypeIcon } from '@/lib/icons';
import { trpc } from '@/lib/trpc';

export function Tokens() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [isCreateFormOpen, setIsCreateFormOpen] = useState(false);
  const [isUpdateFormOpen, setIsUpdateFormOpen] = useState(false);
  const [selectedToken, setSelectedToken] = useState<{
    id: string;
    symbol: string;
    name: string;
    decimals: number;
    typeId: string;
  } | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [filterBy, setFilterBy] = useState(searchParams.get('type') || 'all');

  // Data queries - get tokens with their total values
  const { data: tokensWithValues, isLoading: tokensLoading } =
    trpc.tokens.getWithTotalValues.useQuery();
  const { data: tokenTypes } = trpc.tokenTypes.getAll.useQuery();
  const { data: userPrefs } = trpc.users.getCurrent.useQuery();

  const utils = trpc.useUtils();

  // Update filter when URL parameters change
  useEffect(() => {
    const typeParam = searchParams.get('type');
    if (typeParam) {
      setFilterBy(typeParam);
    } else {
      setFilterBy('all');
    }
  }, [searchParams]);

  // Handler to update filter state and sync with URL
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

  // Filter tokens based on search term and type
  const filteredTokens =
    tokensWithValues?.filter((token) => {
      const matchesSearch =
        !searchTerm ||
        token.symbol.toLowerCase().includes(searchTerm.toLowerCase()) ||
        token.name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        token.typeName?.toLowerCase().includes(searchTerm.toLowerCase());

      const matchesFilter = filterBy === 'all' || token.type === filterBy;

      return matchesSearch && matchesFilter;
    }) || [];

  // Check if token is private (editable)
  const isPrivateToken = (typeCode: string) => {
    return typeCode === 'private-company' || typeCode === 'other';
  };

  // Calculate totals
  const totalValue =
    tokensWithValues?.reduce((sum, token) => {
      return sum + parseFloat(token.totalValueInBaseCurrency);
    }, 0) || 0;

  const filteredValue = filteredTokens.reduce((sum, token) => {
    return sum + parseFloat(token.totalValueInBaseCurrency);
  }, 0);

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
          label: 'Add Token',
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
        baseCurrency={userPrefs?.baseCurrency?.symbol}
        searchTerm={searchTerm}
        onSearchChange={setSearchTerm}
        searchPlaceholder="Search tokens by symbol, name, or type..."
        customFilter={
          <div className="md:w-64">
            <TokenTypeSelector
              value={filterBy}
              onValueChange={handleFilterChange}
              tokenTypes={[{ id: 'all', code: 'all', name: 'All Types' }, ...(tokenTypes || [])]}
              placeholder="Filter by type..."
            />
          </div>
        }
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
            const TypeIcon = getTokenTypeIcon(token.type || 'other');

            return (
              <ItemCard
                key={token.id}
                title={`${token.symbol}${token.name ? ` - ${token.name}` : ''}`}
                subtitle={
                  <div className="flex items-center space-x-2 mb-1">
                    <span className="text-xs px-1.5 py-0.5 bg-muted rounded capitalize">
                      {token.typeName}
                    </span>
                    <span className="text-xs text-muted-foreground">{token.decimals} decimals</span>
                  </div>
                }
                icon={
                  <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
                    <TypeIcon className="h-5 w-5 text-primary" />
                  </div>
                }
                actions={
                  <div className="text-right">
                    <div className="font-semibold">
                      {parseFloat(token.totalBalance).toLocaleString()} {token.symbol}
                    </div>
                    <div className="text-sm text-muted-foreground">
                      {parseFloat(token.totalValueInBaseCurrency).toLocaleString('en-US', {
                        style: 'currency',
                        currency: token.baseCurrencySymbol,
                      })}
                    </div>
                    {isPrivateToken(token.type || '') && (
                      <div className="mt-2">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="sm">
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              onClick={() => {
                                setSelectedToken({
                                  id: token.id,
                                  symbol: token.symbol,
                                  name: token.name || '',
                                  decimals: token.decimals,
                                  typeId: token.typeId || '',
                                });
                                setIsUpdateFormOpen(true);
                              }}
                            >
                              <Edit className="h-4 w-4 mr-2" />
                              Edit Token
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    )}
                  </div>
                }
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
