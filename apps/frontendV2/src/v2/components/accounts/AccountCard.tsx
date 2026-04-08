import type { AccountWihSumaryDTO } from '@scani/shared';
import { Badge } from '@/components/ui/badge';
import { CardInteractive } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import { useBaseCurrency } from '../../hooks/useBaseCurrency';

interface AccountCardProps {
  item: AccountWihSumaryDTO;
  isSelected: boolean;
  onSelect: (id: string) => void;
  institutionName?: string;
  typeName?: string;
  institutionFavicon?: string | null;
}

function formatMoney(value: number, currency = 'USD') {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

export function AccountCard({
  item,
  isSelected,
  onSelect,
  institutionName,
  typeName,
  institutionFavicon,
}: AccountCardProps) {
  const { symbol: currencySymbol } = useBaseCurrency();

  return (
    <CardInteractive className={cn('p-4', isSelected && 'ring-2 ring-primary')}>
      <div className="flex items-start justify-between mb-2">
        <div>
          <p className="font-semibold">{item.name}</p>
          <p className="text-xs text-muted-foreground flex items-center gap-1">
            {institutionFavicon && (
              <img
                src={institutionFavicon}
                alt=""
                className="h-3 w-3 rounded-sm object-contain"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.display = 'none';
                }}
              />
            )}
            {institutionName ?? item.institutionId}
            {typeName && <span className="ml-2 text-muted-foreground/60">{typeName}</span>}
          </p>
        </div>
        <Checkbox
          checked={isSelected}
          onCheckedChange={() => onSelect(item.id)}
          onClick={(e) => e.stopPropagation()}
          className="h-4 w-4"
        />
      </div>

      <p className="text-xl font-bold tabular-nums mt-3">
        {formatMoney(Number.parseFloat(item.summary.totalValue), currencySymbol)}
      </p>
      <p className="text-xs text-muted-foreground mt-1">
        {item.summary.holdingsCount} holding{item.summary.holdingsCount !== 1 ? 's' : ''}
      </p>

      {item.groups.length > 0 && (
        <div className="mt-3 pt-3 border-t border-border flex flex-wrap gap-1">
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
    </CardInteractive>
  );
}
