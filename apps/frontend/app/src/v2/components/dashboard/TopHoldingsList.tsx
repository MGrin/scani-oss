import { formatCurrency } from '@scani/shared';
import { Badge } from '@scani/ui/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@scani/ui/ui/card';
import { Link } from 'react-router-dom';
import { getFaviconUrl } from '@/lib/icons';
import { cn } from '@/lib/utils';
import { V2_ROUTES } from '../../lib/routes';

interface TopHolding {
  id: string;
  symbol: string;
  name: string;
  value: string;
  tokenTypeCode: string;
  accountName?: string;
  institutionName?: string;
  institutionWebsite?: string;
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

export function TopHoldingsList({ holdings, totalValue, currency }: TopHoldingsListProps) {
  return (
    <Card>
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
              const favicon = getFaviconUrl(holding.institutionWebsite);
              // Dashboard API appends "-index" to holding IDs, strip it to get the real UUID
              const holdingId = holding.id.replace(/-\d+$/, '');
              return (
                <Link
                  key={holding.id}
                  to={V2_ROUTES.holdingDetail(holdingId)}
                  className="flex items-center justify-between border-b last:border-b-0 pb-2 -mx-2 px-2 py-1 rounded-md hover:bg-accent/50 transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm">{holding.symbol}</span>
                      <Badge
                        variant="secondary"
                        className={cn(
                          'text-[10px] px-1.5 py-0',
                          TOKEN_TYPE_COLORS[holding.tokenTypeCode.toLowerCase()] ?? 'bg-secondary'
                        )}
                      >
                        {holding.tokenTypeCode}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground truncate">{holding.name}</p>
                    {(holding.institutionName || holding.accountName) && (
                      <p className="text-xs text-muted-foreground/70 flex items-center gap-1 mt-0.5">
                        {favicon && (
                          <img
                            src={favicon}
                            alt=""
                            className="h-3 w-3 rounded-sm object-contain inline-block"
                            onError={(e) => {
                              (e.target as HTMLImageElement).style.display = 'none';
                            }}
                          />
                        )}
                        {holding.institutionName}
                        {holding.accountName && (
                          <span>
                            {holding.institutionName ? ' / ' : ''}
                            {holding.accountName}
                          </span>
                        )}
                      </p>
                    )}
                  </div>
                  <div className="text-right ml-4 shrink-0">
                    <p className="text-sm font-medium">{formatCurrency(val, currency)}</p>
                    <p className="text-xs text-muted-foreground">{pct.toFixed(1)}%</p>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
