import { Combobox } from '@/components/ui/combobox';

interface CurrencySelectorProps {
  value: string;
  onValueChange: (value: string) => void;
  currencies?: Array<{
    id: string;
    symbol: string;
    name: string;
  }>;
  id?: string;
  placeholder?: string;
  popoverWidth?: string;
  compact?: boolean;
  buttonSize?: 'default' | 'sm';
  className?: string;
  side?: 'top' | 'right' | 'bottom' | 'left';
}

export function CurrencySelector({
  value,
  onValueChange,
  currencies,
  id,
  placeholder = 'Select currency...',
  popoverWidth,
  compact = false,
  buttonSize = 'default',
  className,
  side,
}: CurrencySelectorProps) {
  const currencyOptions =
    currencies?.map((currency) => ({
      value: currency.id,
      label: `${currency.symbol} - ${currency.name}`,
      subtitle: currency.name,
    })) || [];

  // Find selected currency to display only its symbol in compact mode
  const selectedCurrency = currencies?.find((c) => c.id === value);
  const displayLabel = compact && selectedCurrency ? selectedCurrency.symbol : undefined;

  return (
    <div id={id} className="w-full">
      <Combobox
        value={value}
        onValueChange={onValueChange}
        placeholder={placeholder}
        emptyMessage="No currencies match your search."
        items={currencyOptions}
        onSearchChange={() => {
          /* debounced in Combobox */
        }}
        className={className}
        popoverWidth={popoverWidth}
        compact={compact}
        buttonSize={buttonSize}
        displayLabel={displayLabel}
        side={side}
      />
    </div>
  );
}
