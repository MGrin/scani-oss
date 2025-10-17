import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { MoneyDisplay } from '@/components/ui/money-display';
import { createCurrencyToken } from '@/lib/utils';

interface SummaryCardProps {
  type: 'currency' | 'count';
  title: string;
  value: number;
  currency?: string;
  label?: string;
  subtitle?: string;
  isAffectedByUnpriceableTokens?: boolean;
}

export function SummaryCard({ type, title, value, currency, label, subtitle }: SummaryCardProps) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {type === 'currency' ? (
          <MoneyDisplay
            value={value}
            token={createCurrencyToken(currency || 'USD')}
            className="text-2xl font-bold"
          />
        ) : (
          <div className="text-2xl font-bold">
            {value.toString()}
            {label && (
              <span className="text-sm font-normal text-muted-foreground ml-1">{label}</span>
            )}
          </div>
        )}
        {subtitle && <p className="text-xs text-muted-foreground mt-1">{subtitle}</p>}
      </CardContent>
    </Card>
  );
}
