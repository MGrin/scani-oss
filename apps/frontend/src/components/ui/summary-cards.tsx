import type { LucideIcon } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  ColoredMonetaryValue,
  MonetaryValue,
  MonetaryValueWithPercentage,
} from '@/components/ui/monetary-value';
import { cn } from '@/lib/utils';

interface BaseSummaryCardProps {
  title: string;
  subtitle?: string;
  icon?: LucideIcon;
  className?: string;
}

interface CurrencySummaryCardProps extends BaseSummaryCardProps {
  type: 'currency';
  value: number;
  currency?: string;
  showSigned?: boolean; // Whether to show colored positive/negative values
  change?: {
    value: number;
    percentage: number;
  };
}

interface TokenSummaryCardProps extends BaseSummaryCardProps {
  type: 'token';
  value: number;
  tokenSymbol: string;
  decimals?: number;
}

interface CountSummaryCardProps extends BaseSummaryCardProps {
  type: 'count';
  value: number;
  label: string;
}

type SummaryCardProps = CurrencySummaryCardProps | TokenSummaryCardProps | CountSummaryCardProps;

/**
 * Unified summary card component for displaying aggregated values
 * Used across Holdings, Accounts, Dashboard for consistent UI
 */
export function SummaryCard(props: SummaryCardProps) {
  const { title, subtitle, icon: Icon, className } = props;

  return (
    <Card className={className}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        {Icon && <Icon className="h-4 w-4 text-muted-foreground" />}
      </CardHeader>
      <CardContent>
        <div className="space-y-1">
          {props.type === 'currency' &&
            (props.change ? (
              <MonetaryValueWithPercentage
                value={props.value}
                percentage={props.change.percentage}
                currency={props.currency}
                size="xl"
                className="font-bold"
              />
            ) : props.showSigned ? (
              <ColoredMonetaryValue
                type="currency"
                value={props.value}
                currency={props.currency}
                size="xl"
                className="font-bold"
                showSign={true}
              />
            ) : (
              <MonetaryValue
                type="currency"
                value={props.value}
                currency={props.currency}
                size="xl"
                className="font-bold"
              />
            ))}

          {props.type === 'token' && (
            <MonetaryValue
              type="token"
              value={props.value}
              tokenSymbol={props.tokenSymbol}
              decimals={props.decimals}
              size="xl"
              className="font-bold"
            />
          )}

          {props.type === 'count' && <div className="text-xl font-bold">{props.value}</div>}

          {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Mini summary card for compact displays (like type summaries)
 */
export function MiniSummaryCard({
  title,
  value,
  currency,
  count,
  icon: Icon,
  className,
}: {
  title: string;
  value: number;
  currency?: string;
  count?: number;
  icon?: LucideIcon;
  className?: string;
}) {
  return (
    <div className={cn('flex items-center space-x-2', className)}>
      {Icon && <Icon className="h-4 w-4 text-muted-foreground" />}
      <div>
        <p className="font-medium text-sm">{title}</p>
        <p className="text-xs text-muted-foreground">
          {count && `${count} ${count === 1 ? 'item' : 'items'} • `}
          <MonetaryValue type="currency" value={value} currency={currency} size="xs" />
        </p>
      </div>
    </div>
  );
}

/**
 * Holding/Account item card for consistent display of individual items
 */
export function ItemCard({
  title,
  subtitle,
  currencyValue,
  tokenValue,
  currency,
  tokenSymbol,
  tokenDecimals,
  icon,
  actions,
  className,
  onClick,
}: {
  title: string;
  subtitle?: string | React.ReactNode;
  currencyValue?: number;
  tokenValue?: number;
  currency?: string;
  tokenSymbol?: string;
  tokenDecimals?: number;
  icon?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
  onClick?: () => void;
}) {
  return (
    <Card
      className={cn('hover:shadow-md transition-shadow', className, onClick && 'cursor-pointer')}
      onClick={onClick}
    >
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-3">
            {icon}
            <div>
              <div className="font-medium text-sm">{title}</div>
              {subtitle && <div className="text-xs text-muted-foreground">{subtitle}</div>}
            </div>
          </div>
          <div className="flex items-center space-x-3">
            <div className="text-right">
              {currencyValue !== undefined && (
                <MonetaryValue
                  type="currency"
                  value={currencyValue}
                  currency={currency}
                  size="base"
                  className="font-semibold"
                />
              )}
              {tokenValue !== undefined && tokenSymbol && (
                <div className="text-xs text-muted-foreground">
                  <MonetaryValue
                    type="token"
                    value={tokenValue}
                    tokenSymbol={tokenSymbol}
                    decimals={tokenDecimals}
                    size="xs"
                  />
                </div>
              )}
            </div>
            {actions}
          </div>
        </div>
      </CardHeader>
    </Card>
  );
}
