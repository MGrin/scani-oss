import { useNavigate } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { MoneyDisplay } from '@/components/ui/money-display';
import { createCurrencyToken } from '@/lib/utils';

interface PortfolioValueCardProps {
  value: number;
  currency: string;
}

export function PortfolioValueCard({ value, currency }: PortfolioValueCardProps) {
  const navigate = useNavigate();

  return (
    <Card
      className="cursor-pointer hover:shadow-lg transition-shadow"
      onClick={() => navigate('/portfolio-history')}
    >
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">Total Portfolio Value</CardTitle>
      </CardHeader>
      <CardContent>
        <MoneyDisplay
          value={value}
          token={createCurrencyToken(currency)}
          className="text-2xl font-bold"
        />
        <p className="text-xs text-muted-foreground mt-1">Click to view history</p>
      </CardContent>
    </Card>
  );
}
