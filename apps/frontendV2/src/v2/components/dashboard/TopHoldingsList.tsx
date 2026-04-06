import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface TopHolding {
  id: string;
  symbol: string;
  name: string;
  value: string;
  tokenTypeCode: string;
}

interface TopHoldingsListProps {
  holdings: TopHolding[];
  totalValue: number;
  currency: string;
}

const TOKEN_TYPE_COLORS: Record<string, string> = {
  crypto: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  stock: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  fiat: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200',
  bond: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200',
  commodity: 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200',
};

function formatMoney(value: number, currency: string) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

export function TopHoldingsList({ holdings, totalValue, currency }: TopHoldingsListProps) {
  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>Top Holdings</CardTitle>
      </CardHeader>
      <CardContent>
        {holdings.length === 0 ? (
          <p className="text-sm text-muted-foreground">No holdings yet</p>
        ) : (
          <div className="space-y-3">
            {holdings.map((holding) => {
              const val = Number.parseFloat(holding.value);
              const pct = totalValue > 0 ? (val / totalValue) * 100 : 0;
              return (
                <div
                  key={holding.id}
                  className="flex items-center justify-between border-b last:border-b-0 pb-2"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm">{holding.symbol}</span>
                      <Badge
                        variant="secondary"
                        className={
                          TOKEN_TYPE_COLORS[holding.tokenTypeCode.toLowerCase()] ?? 'bg-secondary'
                        }
                      >
                        {holding.tokenTypeCode}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground truncate">{holding.name}</p>
                  </div>
                  <div className="text-right ml-4 shrink-0">
                    <p className="text-sm font-medium">{formatMoney(val, currency)}</p>
                    <p className="text-xs text-muted-foreground">{pct.toFixed(1)}%</p>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
