import { Check, ChevronsUpDown, Plus, Search } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { LoadingSpinner } from '@/components/ui/loading';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { TokenSymbol } from '@/components/ui/TokenSymbol';
import { trpc } from '@/lib/trpc';
import { cn } from '@/lib/utils';

interface TokenOption {
  id?: string;
  symbol: string;
  name: string;
  typeId?: string;
  type?: string | null;
  typeName?: string | null;
  decimals?: number;
  iconUrl?: string | null;
  isActive?: boolean;
  source: 'database' | 'external' | 'create-new';
  provider?: 'finnhub' | 'coingecko';
  metadata?: Record<string, unknown>;
}

interface AsyncTokenSelectorProps {
  value: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  id?: string;
  className?: string;
  disabled?: boolean;
}

export function AsyncTokenSelector({
  value,
  onValueChange,
  placeholder = 'Search for tokens...',
  id,
  className,
  disabled = false,
}: AsyncTokenSelectorProps) {
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');

  // Debounce search query
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(searchQuery);
    }, 300);

    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Search tokens using TRPC
  const {
    data: searchResults = [],
    isLoading: isSearching,
    error: searchError,
  } = trpc.tokens.search.useQuery(
    { query: debouncedQuery, limit: 20 },
    {
      enabled: debouncedQuery.length >= 1,
      staleTime: 30000, // Cache for 30 seconds
    }
  );

  // Get all tokens for initial display (when no search query)
  const { data: allTokens = [] } = trpc.tokens.getAll.useQuery(
    undefined,
    { staleTime: 60000 } // Cache for 1 minute
  );

  // Combine search results with "Create New Token" option
  const options = useMemo((): TokenOption[] => {
    const baseOptions: TokenOption[] =
      debouncedQuery.length >= 1
        ? searchResults.map((token) => ({
            ...token,
            source: token.source as 'database' | 'external',
          }))
        : allTokens.map((token) => ({
            ...token,
            source: 'database' as const,
          }));

    // Add "Create New Token" option
    const createNewOption: TokenOption = {
      symbol: 'NEW',
      name: 'Create New Token',
      source: 'create-new' as const,
    };

    return [createNewOption, ...baseOptions];
  }, [debouncedQuery, searchResults, allTokens]);

  // Find selected option
  const selectedOption = options.find(
    (option) => option.id === value || (option.source === 'create-new' && value === 'new')
  );

  // Handle selection
  const handleSelect = useCallback(
    (option: TokenOption) => {
      if (option.source === 'create-new') {
        onValueChange('new');
      } else if (option.source === 'database' && option.id) {
        onValueChange(option.id);
      } else if (option.source === 'external') {
        // For external tokens, we'll use a special format that includes the metadata
        // The parent component will handle creating the token when saving the holding
        onValueChange(
          `external:${option.symbol}:${JSON.stringify({
            symbol: option.symbol,
            name: option.name,
            provider: option.provider,
            metadata: option.metadata,
          })}`
        );
      }
      setOpen(false);
    },
    [onValueChange]
  );

  // Handle search input change
  const handleSearchChange = useCallback((search: string) => {
    setSearchQuery(search);
  }, []);

  // Format display value
  const displayValue = useMemo(() => {
    if (!value) return placeholder;

    if (value === 'new') return 'Create New Token';

    if (value.startsWith('external:')) {
      try {
        const parts = value.split(':');
        const metadata = JSON.parse(parts.slice(2).join(':'));
        return `${metadata.symbol} - ${metadata.name} (External)`;
      } catch {
        return 'External Token';
      }
    }

    if (selectedOption) {
      return `${selectedOption.symbol} - ${selectedOption.name}`;
    }

    return placeholder;
  }, [value, selectedOption, placeholder]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn('w-full justify-between', className)}
          disabled={disabled}
        >
          <span className="truncate">{displayValue}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[400px] p-0" align="start">
        <Command shouldFilter={false}>
          <div className="flex items-center border-b px-3">
            <Search className="mr-2 h-4 w-4 shrink-0 opacity-50" />
            <CommandInput
              placeholder="Search tokens..."
              value={searchQuery}
              onValueChange={handleSearchChange}
              className="flex h-10 w-full rounded-md bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
            />
          </div>
          <CommandList className="max-h-[300px]">
            {isSearching && debouncedQuery && (
              <div className="flex items-center justify-center p-4">
                <LoadingSpinner className="h-4 w-4 mr-2" />
                <span className="text-sm text-muted-foreground">Searching...</span>
              </div>
            )}

            {searchError && (
              <div className="p-4 text-sm text-destructive">
                Error searching tokens: {searchError.message}
              </div>
            )}

            {!isSearching &&
              options.length === 1 &&
              options[0]?.source === 'create-new' &&
              debouncedQuery && (
                <CommandEmpty>No tokens found. You can create a new one.</CommandEmpty>
              )}

            <CommandGroup>
              {options.map((option, index) => {
                const isSelected =
                  option.source === 'create-new'
                    ? value === 'new'
                    : option.id === value || value.includes(option.symbol);

                return (
                  <CommandItem
                    key={`${option.source}-${option.symbol}-${index}`}
                    value={`${option.symbol}-${option.name}`}
                    onSelect={() => handleSelect(option)}
                    className="flex items-center gap-2 px-2 py-2"
                  >
                    <Check
                      className={cn('mr-2 h-4 w-4', isSelected ? 'opacity-100' : 'opacity-0')}
                    />

                    {option.source === 'create-new' ? (
                      <>
                        <Plus className="h-4 w-4 text-muted-foreground" />
                        <span className="font-medium">{option.name}</span>
                      </>
                    ) : (
                      <>
                        <TokenSymbol
                          type={option.type || 'unknown'}
                          symbol={option.symbol}
                          className="h-4 w-4"
                        />
                        <div className="flex flex-col flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-medium">{option.symbol}</span>
                            <span className="text-muted-foreground">-</span>
                            <span className="truncate">{option.name}</span>
                            {option.source === 'external' && (
                              <span className="text-xs bg-blue-100 text-blue-800 px-2 py-0.5 rounded">
                                {option.provider?.toUpperCase()}
                              </span>
                            )}
                          </div>
                          {option.typeName && (
                            <span className="text-xs text-muted-foreground">{option.typeName}</span>
                          )}
                        </div>
                      </>
                    )}
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
