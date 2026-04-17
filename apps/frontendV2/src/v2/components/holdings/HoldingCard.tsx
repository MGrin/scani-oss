import type { HoldingWithDetails } from '@scani/shared';
import { Badge } from '@/components/ui/badge';
import { CardInteractive } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { getFaviconUrl } from '@/lib/icons';
import { cn } from '@/lib/utils';
import { useBaseCurrency } from '../../hooks/useBaseCurrency';
import { formatMoney } from '../../lib/format';
import { FaviconImg } from '../shared/FaviconImg';

interface HoldingCardProps {
  item: HoldingWithDetails;
  isSelected: boolean;
  onSelect: (id: string) => void;
}

const TOKEN_TYPE_COLORS: Record<string, string> = {
  crypto: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  stock: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  fiat: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200',
  bond: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200',
  commodity: 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200',
};

function formatRelativeTime(dateStr: string): string {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'now';
  if (diffMin < 60) return `${diffMin}m`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h`;
  const diffDays = Math.floor(diffHr / 24);
  if (diffDays < 30) return `${diffDays}d`;
  return new Date(dateStr).toLocaleDateString();
}

export function HoldingCard({ item, isSelected, onSelect }: HoldingCardProps) {
  const { symbol: currencySymbol } = useBaseCurrency();
  const favicon = getFaviconUrl(item.institution.website);

  return (
    <CardInteractive className={cn('p-4', isSelected && 'ring-2 ring-primary')}>
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="font-semibold">{item.token.symbol}</span>
          <Badge
            variant="secondary"
            className={cn(
              'text-[10px] px-1.5 py-0',
              TOKEN_TYPE_COLORS[item.token.typeCode.toLowerCase()] ?? 'bg-secondary'
            )}
          >
            {item.token.typeCode}
          </Badge>
        </div>
        <Checkbox
          checked={isSelected}
          onCheckedChange={() => onSelect(item.id)}
          onClick={(e) => e.stopPropagation()}
          className="h-4 w-4"
        />
      </div>
      <p className="text-xs text-muted-foreground truncate mb-3">{item.token.name}</p>
      <p className="text-xl font-bold tabular-nums">{formatMoney(item.value, currencySymbol)}</p>
      <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
        <span>{item.amount.toLocaleString()} units</span>
        {item.price && (
          <span>
            @ {formatMoney(Number.parseFloat(item.price.value), currencySymbol)}
            {item.price.timestamp && (
              <span className="text-muted-foreground/50 ml-1">
                ({formatRelativeTime(item.price.timestamp)})
              </span>
            )}
          </span>
        )}
      </div>
      {item.costBasis > 0 && (
        <p
          className={cn(
            'text-xs font-medium mt-1',
            item.value - item.costBasis >= 0
              ? 'text-green-600 dark:text-green-400'
              : 'text-red-600 dark:text-red-400'
          )}
        >
          {item.value - item.costBasis >= 0 ? '+' : ''}
          {formatMoney(item.value - item.costBasis, currencySymbol)} (
          {(((item.value - item.costBasis) / item.costBasis) * 100).toFixed(1)}%)
        </p>
      )}
      <div className="mt-3 pt-3 border-t border-border space-y-1">
        <p className="text-xs text-muted-foreground flex items-center gap-1">
          <FaviconImg
            src={favicon}
            name={item.institution.name}
            className="h-3 w-3 rounded-sm object-contain"
          />
          {item.institution.name} / {item.account.name}
          {item.source && (
            <Badge variant="outline" className="text-[9px] px-1 py-0 ml-1">
              {item.source}
            </Badge>
          )}
        </p>
        {item.groups.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {item.groups.map((g) => (
              <Badge
                key={g.id}
                variant="outline"
                className="text-[10px] px-1.5 py-0"
                style={{ borderColor: g.color, color: g.color }}
              >
                {g.name}
              </Badge>
            ))}
          </div>
        )}
      </div>
    </CardInteractive>
  );
}
