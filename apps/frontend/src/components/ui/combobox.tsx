'use client';

import { Check, ChevronsUpDown } from 'lucide-react';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { cn } from '@/lib/utils';

interface ComboboxProps {
  value: string;
  onValueChange: (value: string) => void;
  placeholder: string;
  searchPlaceholder?: string;
  emptyMessage?: string;
  items: Array<{
    value: string;
    label: string;
    icon?: React.ComponentType<{ className?: string }>;
    subtitle?: string;
    description?: string;
    isInstitution?: boolean;
  }>;
  className?: string;
  disabled?: boolean;
  onSearchChange?: (value: string) => void;
  searchDebounceMs?: number;
}

export function Combobox({
  value,
  onValueChange,
  placeholder,
  searchPlaceholder = 'Search...',
  emptyMessage = 'No items found.',
  items,
  className,
  disabled = false,
  onSearchChange,
  searchDebounceMs = 250,
}: ComboboxProps) {
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState('');
  const debouncedSearch = useDebouncedValue(search, searchDebounceMs);

  // Notify parent when debounced search changes
  React.useEffect(() => {
    if (onSearchChange) onSearchChange(debouncedSearch);
  }, [debouncedSearch, onSearchChange]);

  const selectedItem = items.find((item) => item.value === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn('w-full h-11 min-h-[44px] justify-between', className)}
          disabled={disabled}
        >
          {selectedItem ? (
            <div className="flex items-center space-x-2 truncate">
              {selectedItem.icon && <selectedItem.icon className="h-4 w-4 shrink-0" />}
              <span className="truncate">{selectedItem.label}</span>
            </div>
          ) : (
            <span className="text-muted-foreground">{placeholder}</span>
          )}
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0">
        <Command>
          <CommandInput placeholder={searchPlaceholder} value={search} onValueChange={setSearch} />
          <CommandList>
            <CommandEmpty>{emptyMessage}</CommandEmpty>
            <CommandGroup>
              {items.map((item) => (
                <CommandItem
                  key={item.value}
                  value={item.label}
                  onSelect={() => {
                    onValueChange(item.value === value ? '' : item.value);
                    setOpen(false);
                  }}
                  className="p-2"
                >
                  <div className="flex items-start space-x-2 flex-1">
                    {item.icon && <item.icon className="h-4 w-4 mt-0.5 shrink-0" />}
                    <div className="flex-1 min-w-0">
                      <div className="font-medium">{item.label}</div>
                      {item.subtitle && (
                        <div className="text-sm text-muted-foreground truncate mt-0.5">
                          {item.subtitle}
                        </div>
                      )}
                      {item.isInstitution && item.description && (
                        <div className="text-sm text-muted-foreground mt-1 whitespace-normal">
                          {item.description}
                        </div>
                      )}
                    </div>
                  </div>
                  <Check
                    className={cn(
                      'ml-2 h-4 w-4 shrink-0',
                      value === item.value ? 'opacity-100' : 'opacity-0'
                    )}
                  />
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
