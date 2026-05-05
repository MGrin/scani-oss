import { formatCurrency } from '@scani/shared';
import { Separator } from '@scani/ui/ui/separator';
import { Skeleton } from '@scani/ui/ui/skeleton';
import { ExternalLink } from 'lucide-react';
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { getFaviconUrl } from '@/lib/icons';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { useBaseCurrency } from '../../hooks/useBaseCurrency';
import { V2_ROUTES } from '../../lib/routes';
import { PortfolioCharts } from '../dashboard/PortfolioCharts';

interface InstitutionDetailContentProps {
  institutionId: string;
  mode?: 'panel' | 'fullPage';
}

export function InstitutionDetailContent({
  institutionId,
  mode = 'panel',
}: InstitutionDetailContentProps) {
  const { data: institutions, isLoading } = trpc.institutions.getByUserIdWithSummary.useQuery();
  const { data: accountsData } = trpc.accounts.getByUserIdWithSummary.useQuery();
  const { symbol: currencySymbol } = useBaseCurrency();

  const institution = institutions?.find((i: { id: string }) => i.id === institutionId);

  const institutionAccounts = useMemo(
    () =>
      (accountsData ?? [])
        .filter((a) => a.institutionId === institutionId && a.summary.holdingsCount > 0)
        .sort(
          (a, b) =>
            Number.parseFloat(b.summary.totalValue) - Number.parseFloat(a.summary.totalValue)
        ),
    [accountsData, institutionId]
  );

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }

  if (!institution) {
    return <p className="text-muted-foreground text-sm">Institution not found</p>;
  }

  const isCompact = mode === 'panel';
  const favicon = getFaviconUrl(institution.website);

  return (
    <div className={cn('space-y-6', isCompact && 'space-y-4')}>
      <div>
        <div className="flex items-center gap-2">
          {favicon && (
            <img
              src={favicon}
              alt=""
              className="h-6 w-6 rounded object-contain"
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = 'none';
              }}
            />
          )}
          <h2 className={cn('font-semibold', isCompact ? 'text-lg' : 'text-2xl')}>
            {institution.name}
          </h2>
        </div>
        {institution.website && (
          <a
            href={institution.website}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-primary hover:underline inline-flex items-center gap-1 mt-1"
          >
            {institution.website.replace(/^https?:\/\//, '')}
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <p className="text-xs text-muted-foreground uppercase tracking-wider">Accounts</p>
          <p className="text-xl font-semibold mt-0.5">{institution.summary?.accountCount ?? 0}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground uppercase tracking-wider">Total Value</p>
          <p className="text-xl font-semibold mt-0.5">
            {formatCurrency(Number(institution.summary?.totalValue ?? 0), currencySymbol)}
          </p>
        </div>
      </div>

      <Separator />
      <PortfolioCharts
        scope={{ kind: 'institution', id: institutionId }}
        netWorthTitle={`${institution.name} value over time`}
        pnlTitle={`${institution.name} PnL over time`}
      />

      {institutionAccounts.length > 0 && (
        <>
          <Separator />
          <div>
            <p className="text-xs text-muted-foreground uppercase tracking-wider mb-2">Accounts</p>
            <div className="space-y-1">
              {institutionAccounts.map((account) => (
                <Link
                  key={account.id}
                  to={V2_ROUTES.accountDetail(account.id)}
                  className="flex items-center gap-3 p-3 rounded-md hover:bg-accent/50 transition-colors border border-transparent hover:border-border"
                >
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm truncate">{account.name}</p>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-xs text-muted-foreground">
                        {account.summary.holdingsCount} holding
                        {account.summary.holdingsCount !== 1 ? 's' : ''}
                      </span>
                      {account.groups?.length > 0 && (
                        <div className="flex gap-1">
                          {account.groups.slice(0, 2).map((g) => (
                            <span
                              key={g.id}
                              className="h-2 w-2 rounded-full"
                              style={{ backgroundColor: g.color }}
                              title={g.name}
                            />
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-sm font-semibold tabular-nums">
                      {formatCurrency(
                        Number.parseFloat(account.summary.totalValue),
                        currencySymbol
                      )}
                    </p>
                  </div>
                </Link>
              ))}
            </div>
            <Link
              to={`${V2_ROUTES.holdings}?institution=${institutionId}`}
              className="text-xs text-primary hover:underline mt-2 inline-block"
            >
              View all holdings for this institution
            </Link>
          </div>
        </>
      )}

      {institution.description && (
        <>
          <Separator />
          <div>
            <p className="text-xs text-muted-foreground uppercase tracking-wider">Description</p>
            <p className="text-sm mt-1">{institution.description}</p>
          </div>
        </>
      )}
    </div>
  );
}
