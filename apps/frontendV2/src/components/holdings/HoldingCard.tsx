import type { HoldingWithDetails, Token } from '@scani/shared';
import { AccountBadge, InstitutionBadge, TokenTypeBadge } from '@/components/features';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { MoneyDisplay } from '@/components/ui/money-display';

interface HoldingCardProps {
  holding: HoldingWithDetails;
  isSelected: boolean;
  baseCurrencyToken: Token;
  onSelect: (id: string) => void;
  onClick: (holding: HoldingWithDetails) => void;
}

export function HoldingCard({
  holding,
  isSelected,
  baseCurrencyToken,
  onSelect,
  onClick,
}: HoldingCardProps) {
  return (
    <Card
      className={`hover:shadow-md transition-shadow ${isSelected ? 'ring-2 ring-primary' : ''}`}
    >
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <span className="flex items-center gap-2">
            <div className="min-w-[44px] min-h-[44px] flex items-center justify-center">
              <Checkbox
                checked={isSelected}
                onCheckedChange={() => onSelect(holding.id)}
                onClick={(e) => e.stopPropagation()}
                aria-label={`Select ${holding.token.symbol}`}
              />
            </div>
            <button
              type="button"
              className="cursor-pointer text-left font-semibold hover:underline"
              onClick={() => onClick(holding)}
            >
              {holding.token.symbol || holding.token.name}
            </button>
          </span>
          <TokenTypeBadge tokenTypeCode={holding.token.typeCode} />
        </CardTitle>
        <div className="flex items-center gap-2">
          <AccountBadge
            accountId={holding.account.id}
            accountName={holding.account.name}
            accountTypeCode={holding.account.typeCode}
          />
          <InstitutionBadge
            institutionId={holding.institution.id}
            institutionName={holding.institution.name}
            institutionWebsite={holding.institution.website ?? undefined}
          />
        </div>
      </CardHeader>
      <CardContent className="cursor-pointer" onClick={() => onClick(holding)}>
        <div className="space-y-2">
          <div className="text-2xl font-bold">
            {holding.amount.toString()} {holding.token.symbol}
          </div>
          <div className="text-lg font-semibold">
            <MoneyDisplay value={holding.value} token={baseCurrencyToken} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
