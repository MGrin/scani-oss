import type { Token } from '@scani/shared';
import { forwardRef } from 'react';
import { cn } from '@/lib/utils';

interface MoneyDisplayProps {
  /** The numeric value to display */
  value: string | number;
  /** The token object containing symbol, name, decimals, etc. */
  token: Token;
  /** Optional className for styling */
  className?: string;
  /** Whether to show the token symbol */
  showSymbol?: boolean;
  /** Whether to show the full token name */
  showName?: boolean;
  /** Custom locale for formatting (default: 'en-US') */
  locale?: string;
  /** Custom currency display style */
  currencyDisplay?: 'symbol' | 'narrowSymbol' | 'code' | 'name';
  /** Minimum fraction digits */
  minimumFractionDigits?: number;
  /** Maximum fraction digits */
  maximumFractionDigits?: number;
}

/**
 * MoneyDisplay component for properly formatting monetary values
 * Uses JavaScript Intl.NumberFormat for locale-aware formatting
 */
export const MoneyDisplay = forwardRef<HTMLSpanElement, MoneyDisplayProps>(
  (
    {
      value,
      token,
      className,
      showSymbol = true,
      showName = false,
      locale = 'en-US',
      currencyDisplay = 'symbol',
      minimumFractionDigits,
      maximumFractionDigits,
      ...props
    },
    ref
  ) => {
    const numericValue = typeof value === 'string' ? parseFloat(value) : value;

    if (Number.isNaN(numericValue)) {
      return (
        <span ref={ref} className={cn('text-muted-foreground', className)} {...props}>
          {showSymbol ? `${token.symbol} ` : ''}0.00
        </span>
      );
    }

    // Use token decimals if not overridden
    const minFractionDigits = minimumFractionDigits ?? Math.min(token.decimals, 2);
    const maxFractionDigits = maximumFractionDigits ?? Math.min(token.decimals, 2);

    let formattedValue: string;

    // Check if the symbol is a valid ISO currency code
    const isValidCurrencyCode = (() => {
      try {
        new Intl.NumberFormat('en', {
          style: 'currency',
          currency: token.symbol,
        });
        return true;
      } catch {
        return false;
      }
    })();

    if (isValidCurrencyCode) {
      // For valid ISO currency codes, use Intl.NumberFormat with currency style
      formattedValue = new Intl.NumberFormat(locale, {
        style: 'currency',
        currency: token.symbol,
        currencyDisplay,
        minimumFractionDigits: minFractionDigits,
        maximumFractionDigits: maxFractionDigits,
      }).format(numericValue);
    } else {
      // For crypto tokens or invalid currency codes, format as decimal number with symbol
      const numberFormatter = new Intl.NumberFormat(locale, {
        minimumFractionDigits: minFractionDigits,
        maximumFractionDigits: maxFractionDigits,
      });
      formattedValue = `${numberFormatter.format(numericValue)} ${token.symbol}`;
    }

    // Build the display content
    let displayContent = formattedValue;

    // If we want to show the full name instead of/in addition to symbol
    if (showName && !showSymbol) {
      displayContent = `${token.name} ${formattedValue}`;
    } else if (showName && showSymbol) {
      displayContent = `${formattedValue} (${token.name})`;
    }

    return (
      <span ref={ref} className={className} {...props}>
        {displayContent}
      </span>
    );
  }
);

MoneyDisplay.displayName = 'MoneyDisplay';
