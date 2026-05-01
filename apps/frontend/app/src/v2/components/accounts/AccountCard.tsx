import type { AccountWihSumaryDTO } from '@scani/shared';
import { formatCurrency } from '@scani/shared';
import { Badge } from '@scani/ui/ui/badge';
import { CardInteractive } from '@scani/ui/ui/card';
import { Checkbox } from '@scani/ui/ui/checkbox';
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
        {/* Padded tap target keeps the checkbox easy to hit on mobile
            without accidentally navigating to the detail page. <label>
            semantics expand the click area naturally and side-steps the
            nested-button issue (DataViewCards wraps each card in a
            <button>). The Checkbox is purely visual
            (`pointer-events-none`) so every click — direct on the box
            or in the padding — is handled by the <label>, which then
            stops propagation to the outer card button. */}
        {/* biome-ignore lint/a11y/noLabelWithoutControl: label expands hit area for the nested Checkbox; click handler delegates selection. */}
        <label
          aria-label="Toggle selection"
          onClick={(e) => {
            e.stopPropagation();
            e.preventDefault();
            onSelect(item.id);
          }}
          onKeyDown={(e) => {
            if (e.key === ' ' || e.key === 'Enter') {
              e.stopPropagation();
              e.preventDefault();
              onSelect(item.id);
            }
          }}
          className="-m-2 p-2 rounded-md hover:bg-accent/70 cursor-pointer"
        >
          <Checkbox checked={isSelected} className="h-4 w-4 pointer-events-none" />
        </label>
      </div>

      <p className="text-xl font-bold tabular-nums mt-3">
        {formatCurrency(Number.parseFloat(item.summary.totalValue), currencySymbol)}
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
