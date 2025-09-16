import { FinancialMath } from '@scani/shared';
import { cn } from '@/lib/utils';

interface BaseMonetaryValueProps {
  value: number | string;
  className?: string;
  showSign?: boolean;
  size?: 'xs' | 'sm' | 'base' | 'lg' | 'xl' | '2xl';
}

interface CurrencyValueProps extends BaseMonetaryValueProps {
  type: 'currency';
  currency?: string;
  decimals?: number;
}

interface TokenValueProps extends BaseMonetaryValueProps {
  type: 'token';
  tokenSymbol: string;
  decimals?: number;
}

type MonetaryValueProps = CurrencyValueProps | TokenValueProps;

const sizeClasses = {
  xs: 'text-xs',
  sm: 'text-sm',
  base: 'text-base',
  lg: 'text-lg',
  xl: 'text-xl',
  '2xl': 'text-2xl',
};

/**
 * Unified component for displaying monetary values with proper currency or token formatting
 *
 * For currency values: Uses FinancialMath.formatCurrency with proper currency symbol
 * For token values: Shows formatted token amount with token symbol
 */
export function MonetaryValue(props: MonetaryValueProps) {
  const { value, className, showSign = false, size = 'base' } = props;

  const numericValue = typeof value === 'string' ? parseFloat(value) : value;

  let formattedValue: string;
  let displayValue: string;

  if (props.type === 'currency') {
    // Format as currency using FinancialMath
    formattedValue = FinancialMath.formatCurrency(numericValue, {
      currency: props.currency,
      style: 'currency',
    });
    displayValue = showSign && numericValue > 0 ? `+${formattedValue}` : formattedValue;
  } else {
    // Format as token amount with symbol
    const decimals = props.decimals ?? 2;
    const tokenAmount = numericValue.toFixed(decimals);
    formattedValue = `${tokenAmount} ${props.tokenSymbol}`;
    displayValue = showSign && numericValue > 0 ? `+${formattedValue}` : formattedValue;
  }

  return <span className={cn(sizeClasses[size], className)}>{displayValue}</span>;
}

/**
 * Colored monetary value that shows positive values in green and negative in red
 */
export function ColoredMonetaryValue(props: MonetaryValueProps & { neutralColor?: boolean }) {
  const { neutralColor = false, className, ...otherProps } = props;
  const numericValue = typeof props.value === 'string' ? parseFloat(props.value) : props.value;

  const colorClass = neutralColor
    ? ''
    : numericValue > 0
      ? 'text-green-600'
      : numericValue < 0
        ? 'text-red-600'
        : 'text-muted-foreground';

  return <MonetaryValue {...otherProps} className={cn(colorClass, className)} />;
}

/**
 * Monetary value with percentage indicator (for changes, gains/losses)
 */
export function MonetaryValueWithPercentage({
  value,
  percentage,
  currency,
  className,
  size = 'base',
  showSign = true,
}: {
  value: number;
  percentage: number;
  currency?: string;
  className?: string;
  size?: 'xs' | 'sm' | 'base' | 'lg' | 'xl' | '2xl';
  showSign?: boolean;
}) {
  const isPositive = value > 0;
  const colorClass = isPositive
    ? 'text-green-600'
    : value < 0
      ? 'text-red-600'
      : 'text-muted-foreground';

  return (
    <div className={cn('flex flex-col', className)}>
      <ColoredMonetaryValue
        type="currency"
        value={value}
        currency={currency}
        showSign={showSign}
        size={size}
      />
      <span className={cn('text-xs', colorClass)}>
        {showSign && percentage > 0 ? '+' : ''}
        {percentage.toFixed(2)}%
      </span>
    </div>
  );
}
