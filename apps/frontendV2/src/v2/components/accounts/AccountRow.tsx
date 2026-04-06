import type { AccountWihSumaryDTO } from '@scani/shared';
import { Badge } from '@/components/ui/badge';
import { useBaseCurrency } from '../../hooks/useBaseCurrency';

interface AccountRowProps {
  item: AccountWihSumaryDTO;
  isSelected: boolean;
  onSelect: (id: string) => void;
  institutionName?: string;
  typeName?: string;
}

function formatMoney(value: number, currency = 'USD') {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

export function AccountRow({
  item,
  isSelected,
  onSelect,
  institutionName,
  typeName,
}: AccountRowProps) {
  const { symbol: currencySymbol } = useBaseCurrency();

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
        <span className="font-medium text-sm">{item.name}</span>
      </td>
      <td className="py-2 px-2">
        <Badge variant="outline" className="text-xs">
          {institutionName ?? item.institutionId}
        </Badge>
      </td>
      <td className="py-2 px-2 text-sm text-muted-foreground">{typeName ?? item.typeId}</td>
      <td className="py-2 px-2 text-right text-sm tabular-nums">{item.summary.holdingsCount}</td>
      <td className="py-2 px-2 text-right text-sm font-medium tabular-nums">
        {formatMoney(Number.parseFloat(item.summary.totalValue), currencySymbol)}
      </td>
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
    </>
  );
}
