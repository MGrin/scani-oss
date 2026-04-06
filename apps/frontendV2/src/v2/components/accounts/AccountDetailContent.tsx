import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';

interface AccountDetailContentProps {
  accountId: string;
  mode?: 'panel' | 'fullPage';
}

export function AccountDetailContent({ accountId, mode = 'panel' }: AccountDetailContentProps) {
  const { data: account, isLoading } = trpc.accounts.getById.useQuery({ id: accountId });
  const { data: holdingsData } = trpc.accounts.getHoldings.useQuery({ id: accountId });

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }

  if (!account) {
    return <p className="text-muted-foreground text-sm">Account not found</p>;
  }

  const isCompact = mode === 'panel';
  const holdings = Array.isArray(holdingsData) ? holdingsData : holdingsData?.holdings || [];

  return (
    <div className={cn('space-y-6', isCompact && 'space-y-4')}>
      <div>
        <h2 className={cn('font-semibold', isCompact ? 'text-lg' : 'text-2xl')}>{account.name}</h2>
        <p className="text-sm text-muted-foreground mt-0.5">
          {account.description || 'No description'}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <p className="text-xs text-muted-foreground uppercase tracking-wider">Holdings</p>
          <p className="text-xl font-semibold mt-0.5">{holdings.length}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground uppercase tracking-wider">Status</p>
          <Badge variant={account.isActive ? 'default' : 'secondary'} className="mt-1">
            {account.isActive ? 'Active' : 'Inactive'}
          </Badge>
        </div>
      </div>

      <Separator />

      {/* Holdings list */}
      {holdings.length > 0 && (
        <div>
          <p className="text-xs text-muted-foreground uppercase tracking-wider mb-2">Holdings</p>
          <div className="space-y-2">
            {holdings
              .slice(0, 10)
              .map(
                (h: {
                  id: string;
                  token?: { symbol: string };
                  balance?: string;
                  value?: number;
                }) => (
                  <div key={h.id} className="flex items-center justify-between text-sm">
                    <span className="font-medium">{h.token?.symbol || 'Unknown'}</span>
                    <span className="text-muted-foreground">{h.balance || '0'}</span>
                  </div>
                )
              )}
            {holdings.length > 10 && (
              <p className="text-xs text-muted-foreground">+{holdings.length - 10} more</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
