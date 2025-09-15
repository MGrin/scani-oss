import { Building2, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { InstitutionTypeSelector } from '@/components/selectors/SearchableSelectors';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { LoadingSpinner } from '@/components/ui/loading';
import { PageAggregation } from '@/components/ui/page-aggregation';
import { PageHeader } from '@/components/ui/page-header';
import { ItemCard } from '@/components/ui/summary-cards';
import type { ApiInstitution } from '@/lib/api-types';
import { getInstitutionTypeIcon } from '@/lib/icons';
import { trpc } from '@/lib/trpc';

export function Institutions() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [searchTerm, setSearchTerm] = useState('');
  const [filterBy, setFilterBy] = useState<string>(searchParams.get('type') || 'all');

  // Update filter when URL parameters change
  useEffect(() => {
    const typeParam = searchParams.get('type');
    if (typeParam) {
      setFilterBy(typeParam);
    } else {
      setFilterBy('all');
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

  const { data: institutions, isLoading } = trpc.institutions.getByUserId.useQuery();
  const { data: institutionTypes } = trpc.institutionTypes.getAll.useQuery();
  const { data: accounts } = trpc.accounts.getAll.useQuery();
  const { data: userPrefs } = trpc.users.getCurrent.useQuery();
  const { data: portfolioValue } = trpc.users.getPortfolioValue.useQuery();
  const { data: holdings } = trpc.holdings.getAll.useQuery();
  const { data: tokens } = trpc.tokens.getAll.useQuery();

  const getInstitutionTypeLabel = (type: string) => {
    const institutionType = institutionTypes?.find(
      (t: { code: string; name: string }) => t.code === type
    );
    return institutionType?.name || type;
  };

  // Filter institutions based on search and type
  const filteredInstitutions =
    institutions?.filter((institution: ApiInstitution) => {
      const matchesSearch =
        !searchTerm ||
        institution.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        institution.description?.toLowerCase().includes(searchTerm.toLowerCase());

      const matchesFilter = filterBy === 'all' || institution.type === filterBy;

      return matchesSearch && matchesFilter;
    }) || [];

  // Create tokens map for lookups
  const tokensMap = tokens ? Object.fromEntries(tokens.map((token) => [token.id, token])) : {};

  // Calculate institution balances and totals using portfolio value (base currency converted)
  const getInstitutionBalance = (institutionId: string): number => {
    if (!accounts || !portfolioValue?.holdings || !holdings || !tokens) return 0;

    // Get accounts for this institution
    const institutionAccounts = accounts.filter((acc) => acc.institutionId === institutionId);

    // Sum up holdings values for accounts in this institution
    return institutionAccounts.reduce((total, account) => {
      // Find holdings that belong to this account
      const accountHoldings = holdings.filter((holding) => holding.accountId === account.id);

      // Sum up the converted values for these holdings
      const accountTotal = accountHoldings.reduce((accSum, holding) => {
        // Get token info for this holding
        const token = tokensMap[holding.tokenId];
        if (!token) return accSum;

        // Find the corresponding portfolio holding with converted value
        const portfolioHolding = portfolioValue.holdings.find(
          (ph) => ph.tokenSymbol === token.symbol
        );

        if (portfolioHolding?.value) {
          // Calculate proportion of this holding relative to total holdings of same token
          const tokenHoldings = holdings.filter((h) => h.tokenId === holding.tokenId);
          const totalTokenBalance = tokenHoldings.reduce(
            (sum, h) => sum + parseFloat(h.balance || '0'),
            0
          );
          const holdingBalance = parseFloat(holding.balance || '0');

          if (totalTokenBalance > 0) {
            const proportion = holdingBalance / totalTokenBalance;
            return accSum + parseFloat(portfolioHolding.value) * proportion;
          }
        }
        return accSum;
      }, 0);

      return total + accountTotal;
    }, 0);
  };

  // Use portfolio total value (already in base currency)
  const totalBalance = portfolioValue
    ? typeof portfolioValue.totalValue === 'string'
      ? parseFloat(portfolioValue.totalValue)
      : portfolioValue.totalValue
    : 0;
  const filteredBalance = filteredInstitutions.reduce(
    (total, inst) => total + getInstitutionBalance(inst.id),
    0
  );

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
        primaryAction={{
          label: 'Add Holding',
          onClick: () => navigate('/quick-add-holding'),
          icon: <Plus className="h-4 w-4 mr-1" />,
        }}
      />

      <PageAggregation
        totalCount={institutions?.length || 0}
        filteredCount={filteredInstitutions.length}
        entityLabel="institutions"
        totalBalance={totalBalance}
        filteredBalance={filteredBalance}
        baseCurrency={userPrefs?.baseCurrency?.symbol}
        searchTerm={searchTerm}
        onSearchChange={setSearchTerm}
        searchPlaceholder="Search institutions by name, type, or description..."
        filterBy={filterBy}
        onFilterChange={handleFilterChange}
        customFilter={
          <div className="md:w-64">
            <InstitutionTypeSelector
              value={filterBy}
              onValueChange={handleFilterChange}
              institutionTypes={[
                { id: 'all', code: 'all', name: 'All Types' },
                ...(institutionTypes || []),
              ]}
              placeholder="Filter by type..."
            />
          </div>
        }
      />

      {!institutions || institutions.length === 0 ? (
        <Card>
          <CardContent className="p-12 text-center">
            <Building2 className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold mb-2">No institutions yet</h3>
            <p className="text-muted-foreground mb-6 max-w-md mx-auto">
              You haven't added any holdings yet. When you create your first holding, the associated
              institution will appear here automatically.
            </p>
            <Button onClick={() => navigate('/quick-add-holding')}>
              <Plus className="h-4 w-4 mr-2" />
              Create Your First Holding
            </Button>
          </CardContent>
        </Card>
      ) : filteredInstitutions.length === 0 ? (
        <Card>
          <CardContent className="p-12 text-center">
            <div className="text-muted-foreground mb-4">
              No institutions match your search criteria
            </div>
            <Button
              onClick={() => {
                setSearchTerm('');
                setFilterBy('all');
              }}
            >
              Clear Filters
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          <div className="text-sm text-muted-foreground">
            These are the financial institutions where you have accounts with holdings. Click on an
            institution to view its accounts.
          </div>

          <div className="space-y-3">
            {filteredInstitutions.map((institution: ApiInstitution) => {
              const balance = getInstitutionBalance(institution.id);
              const accountCount =
                accounts?.filter((acc) => acc.institutionId === institution.id).length || 0;

              return (
                <ItemCard
                  key={institution.id}
                  title={institution.name}
                  subtitle={
                    <div className="space-y-1">
                      <div className="flex items-center space-x-2">
                        <span className="text-xs px-1.5 py-0.5 bg-muted rounded capitalize">
                          {getInstitutionTypeLabel(institution.type ?? '')}
                        </span>
                      </div>
                      <div className="flex items-center space-x-1 text-xs text-muted-foreground">
                        <span>{accountCount} accounts</span>
                        <span>•</span>
                        <span>Added {new Date(institution.createdAt).toLocaleDateString()}</span>
                      </div>
                      {institution.description && (
                        <div
                          className="text-xs text-muted-foreground truncate"
                          title={institution.description}
                        >
                          {institution.description}
                        </div>
                      )}
                    </div>
                  }
                  currencyValue={balance}
                  currency={userPrefs?.baseCurrency?.symbol}
                  icon={(() => {
                    const IconComponent = getInstitutionTypeIcon(institution.type ?? '');
                    return (
                      <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
                        <IconComponent className="h-5 w-5 text-primary" />
                      </div>
                    );
                  })()}
                  onClick={() => navigate(`/institutions/${institution.id}`)}
                />
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
