import type { HoldingWithDetails } from '@scani/shared';
import { Badge } from '@/components/ui/badge';
import { CardInteractive } from '@/components/ui/card';
import { cn } from '@/lib/utils';

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

function formatMoney(value: number) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

export function HoldingCard({ item, isSelected, onSelect }: HoldingCardProps) {
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
        <input
          type="checkbox"
          checked={isSelected}
          onChange={(e) => {
            e.stopPropagation();
            onSelect(item.id);
          }}
          className="rounded border-border"
        />
      </div>
      <p className="text-xs text-muted-foreground truncate mb-3">{item.token.name}</p>
      <p className="text-xl font-bold tabular-nums">{formatMoney(item.value)}</p>
      <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
        <span>{item.amount.toLocaleString()} units</span>
        {item.price && <span>@ ${Number.parseFloat(item.price.value).toLocaleString()}</span>}
      </div>
      <div className="mt-3 pt-3 border-t border-border space-y-1">
        <p className="text-xs text-muted-foreground">
          {item.institution.name} / {item.account.name}
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
