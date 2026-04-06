import type { HoldingWithDetails } from '@scani/shared';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

interface HoldingRowProps {
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

export function HoldingRow({ item, isSelected, onSelect }: HoldingRowProps) {
  return (
    <>
      <td className="py-2 px-2">
        <input
          type="checkbox"
          checked={isSelected}
          onChange={() => onSelect(item.id)}
          className="rounded border-border"
        />
      </td>
      <td className="py-2 px-2">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm">{item.token.symbol}</span>
          <span className="text-xs text-muted-foreground truncate max-w-[120px]">
            {item.token.name}
          </span>
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
      </td>
      <td className="py-2 px-2 text-right text-sm tabular-nums">{item.amount.toLocaleString()}</td>
      <td className="py-2 px-2 text-right text-sm font-medium tabular-nums">
        {formatMoney(item.value)}
      </td>
      <td className="py-2 px-2 text-right text-sm text-muted-foreground tabular-nums">
        {item.price ? `$${Number.parseFloat(item.price.value).toLocaleString()}` : '-'}
      </td>
      <td className="py-2 px-2 text-sm text-muted-foreground">{item.account.name}</td>
      <td className="py-2 px-2 text-sm text-muted-foreground">{item.institution.name}</td>
      <td className="py-2 px-2">
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
      </td>
      <td className="py-2 px-2">
        <Badge variant={item.isActive ? 'default' : 'secondary'} className="text-[10px]">
          {item.isActive ? 'Active' : 'Inactive'}
        </Badge>
      </td>
    </>
  );
}
