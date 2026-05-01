import { Button } from '@scani/ui/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@scani/ui/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@scani/ui/ui/popover';
import { Check, ChevronsUpDown, Loader2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';

type ValueField = 'id' | 'symbol';

interface FiatCurrencySelectProps {
  value: string;
  onChange: (value: string) => void;
  /** Which field on the currency record to read/write. Defaults to 'id'. */
  valueField?: ValueField;
  /** 'full' renders "USD — US Dollar"; 'compact' renders just "USD". */
  variant?: 'full' | 'compact';
  placeholder?: string;
  disabled?: boolean;
  /** id forwarded to the trigger button so a <Label htmlFor> can focus it. */
  id?: string;
  triggerClassName?: string;
}

export function FiatCurrencySelect({
  value,
  onChange,
  valueField = 'id',
  variant = 'full',
  placeholder = 'Select currency',
  disabled,
  id,
  triggerClassName,
}: FiatCurrencySelectProps) {
  const [open, setOpen] = useState(false);
  const { data: currencies, isLoading } = trpc.users.getSupportedCurrencies.useQuery();

  const list = currencies ?? [];

  const selected = useMemo(() => {
    if (!value) return null;
    return list.find((c) => (valueField === 'id' ? c.id : c.symbol) === value) ?? null;
  }, [list, value, valueField]);

  const triggerLabel = selected
    ? variant === 'compact'
      ? selected.symbol
      : `${selected.symbol} — ${selected.name}`
    : placeholder;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled || isLoading}
          className={cn(
            'w-full justify-between font-normal',
            !selected && 'text-muted-foreground',
            triggerClassName
          )}
        >
          <span className="truncate">{triggerLabel}</span>
          {isLoading ? (
            <Loader2 className="ml-2 h-4 w-4 shrink-0 animate-spin opacity-50" />
          ) : (
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] min-w-[240px] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search currencies…" />
          <CommandList>
            <CommandEmpty>No currency found.</CommandEmpty>
            <CommandGroup>
              {list.map((c) => {
                const storeValue = valueField === 'id' ? c.id : c.symbol;
                const isSelected = selected
                  ? valueField === 'id'
                    ? c.id === selected.id
                    : c.symbol === selected.symbol
                  : false;
                return (
                  <CommandItem
                    key={c.id}
                    value={`${c.symbol} ${c.name}`}
                    onSelect={() => {
                      onChange(storeValue);
                      setOpen(false);
                    }}
                  >
                    <Check
                      className={cn(
                        'mr-2 h-4 w-4 shrink-0',
                        isSelected ? 'opacity-100' : 'opacity-0'
                      )}
                    />
                    <span className="font-medium w-14 shrink-0">{c.symbol}</span>
                    <span className="text-muted-foreground text-xs truncate">{c.name}</span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
