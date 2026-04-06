import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { useBaseCurrency } from '../../hooks/useBaseCurrency';

function formatMoney(value: number, currency = 'USD') {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

interface HoldingDetailContentProps {
  holdingId: string;
  mode?: 'panel' | 'fullPage';
  onClose?: () => void;
}

export function HoldingDetailContent({ holdingId, mode = 'panel' }: HoldingDetailContentProps) {
  const { symbol: currencySymbol } = useBaseCurrency();
  const { data: holdingsData, isLoading } = trpc.holdings.getWithDetails.useQuery();
  const holding = holdingsData?.holdings?.find((h: { id: string }) => h.id === holdingId);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }

  if (!holding) {
    return <p className="text-muted-foreground text-sm">Holding not found</p>;
  }

  const isCompact = mode === 'panel';

  return (
    <div className={cn('space-y-6', isCompact && 'space-y-4')}>
      {/* Header */}
      <div>
        <div className="flex items-center gap-2">
          <h2 className={cn('font-semibold', isCompact ? 'text-lg' : 'text-2xl')}>
            {holding.token.symbol}
          </h2>
          <Badge variant="outline" className="text-xs">
            {holding.token.type || holding.token.typeCode}
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground mt-0.5">{holding.token.name}</p>
      </div>

      {/* Value section */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <p className="text-xs text-muted-foreground uppercase tracking-wider">Value</p>
          <p className="text-xl font-semibold mt-0.5">
            {formatMoney(typeof holding.value === 'number' ? holding.value : 0, currencySymbol)}
          </p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground uppercase tracking-wider">Amount</p>
          <p className="text-xl font-semibold mt-0.5">
            {typeof holding.amount === 'number'
              ? holding.amount.toLocaleString('en-US', { maximumFractionDigits: 8 })
              : holding.amount}
          </p>
        </div>
      </div>

      <Separator />

      {/* Details */}
      <div className="space-y-3">
        <DetailRow
          label="Price"
          value={
            holding.price?.value ? formatMoney(Number(holding.price.value), currencySymbol) : 'N/A'
          }
        />
        <DetailRow label="Account" value={holding.account?.name || '-'} />
        <DetailRow label="Institution" value={holding.institution?.name || '-'} />
        <DetailRow
          label="Status"
          value={
            <Badge variant={holding.isActive ? 'default' : 'secondary'} className="text-xs">
              {holding.isActive ? 'Active' : 'Inactive'}
            </Badge>
          }
        />
        <DetailRow
          label="Last Updated"
          value={holding.lastUpdated ? new Date(holding.lastUpdated).toLocaleDateString() : '-'}
        />
      </div>

      {holding.groups && holding.groups.length > 0 && (
        <>
          <Separator />
          <div>
            <p className="text-xs text-muted-foreground uppercase tracking-wider mb-2">Groups</p>
            <div className="flex flex-wrap gap-1.5">
              {holding.groups.map((g: { id: string; name: string; color?: string }) => (
                <Badge
                  key={g.id}
                  variant="outline"
                  className="text-xs"
                  style={g.color ? { borderColor: g.color, color: g.color } : undefined}
                >
                  {g.name}
                </Badge>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}
