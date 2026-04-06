import { ExternalLink } from 'lucide-react';
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { getFaviconUrl } from '@/lib/icons';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { useBaseCurrency } from '../../hooks/useBaseCurrency';
import { V2_ROUTES } from '../../lib/routes';

interface InstitutionDetailContentProps {
  institutionId: string;
  mode?: 'panel' | 'fullPage';
}

function formatMoney(value: number, currency: string) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
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
            {formatMoney(Number(institution.summary?.totalValue ?? 0), currencySymbol)}
          </p>
        </div>
      </div>

      {institutionAccounts.length > 0 && (
        <>
          <Separator />
          <div>
            <p className="text-xs text-muted-foreground uppercase tracking-wider mb-2">Accounts</p>
            <div className="space-y-2">
              {institutionAccounts.map((account) => (
                <Link
                  key={account.id}
                  to={V2_ROUTES.accountDetail(account.id)}
                  className="flex items-center justify-between text-sm p-2 rounded-md hover:bg-accent/50 transition-colors"
                >
                  <div>
                    <span className="font-medium">{account.name}</span>
                    <span className="text-xs text-muted-foreground ml-2">
                      {account.summary.holdingsCount} holdings
                    </span>
                  </div>
                  <span className="font-medium tabular-nums">
                    {formatMoney(Number.parseFloat(account.summary.totalValue), currencySymbol)}
                  </span>
                </Link>
              ))}
            </div>
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
