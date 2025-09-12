import type { LucideIcon } from 'lucide-react';
import { getTokenDisplay } from '@/lib/icons';

/**
 * Component to render either a symbol or an icon for tokens
 */
interface TokenSymbolProps {
  type: string;
  symbol?: string;
  className?: string;
}

export function TokenSymbol({ type, symbol, className = '' }: TokenSymbolProps) {
  const display = getTokenDisplay(type, symbol);

  if (display.type === 'symbol') {
    return (
      <span className={`inline-flex items-center justify-center font-semibold ${className}`}>
        {display.value as string}
      </span>
    );
  }

  const IconComponent = display.value as LucideIcon;
  return <IconComponent className={className} />;
}
