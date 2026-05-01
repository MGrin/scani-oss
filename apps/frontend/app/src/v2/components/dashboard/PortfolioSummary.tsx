import { formatCurrency } from '@scani/shared';
import { Card, CardContent } from '@scani/ui/ui/card';

interface PortfolioSummaryProps {
  value: number;
  currency: string;
}

export function PortfolioSummary({ value, currency }: PortfolioSummaryProps) {
  const formatted = formatCurrency(value, currency);

  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-sm font-medium text-muted-foreground">Total Portfolio Value</p>
        <p className="mt-2 text-2xl sm:text-3xl font-bold tracking-tight truncate">{formatted}</p>
      </CardContent>
    </Card>
  );
}
