import type { LucideIcon } from 'lucide-react';
import { Check, ChevronsUpDown, Plus } from 'lucide-react';
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
import { Skeleton } from '@/components/ui/skeleton';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import {
  buildExternalTokenValue,
  isExternalTokenValue,
  parseExternalTokenValue,
} from '@/lib/external-token';
import { getFaviconUrl, getTokenTypeIcon } from '@/lib/icons';
import { trpc } from '@/lib/trpc';
import { cn, normalizeSymbol } from '@/lib/utils';

interface TokenOption {
  id?: string;
  symbol: string;
  name: string;
  typeId?: string;
  type?: string | null;
  typeName?: string | null;
  decimals?: number;
  isActive?: boolean;
  source: 'database' | 'external' | 'create-new';
  provider?: 'finnhub' | 'coingecko';
  metadata?: Record<string, unknown>;
}

interface TokenSearchableSelectorProps {
  value: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  id?: string;
  className?: string;
  disabled?: boolean;
  suggestedTokens?: TokenOption[]; // Restrict to these tokens when provided
  allowCreateNew?: boolean; // Allow creating new tokens (default: true)
}

export function TokenSearchableSelector({
  value,
  onValueChange,
  placeholder = 'Search for tokens...',
  id,
  className,
  disabled = false,
  suggestedTokens,
  allowCreateNew = true,
}: TokenSearchableSelectorProps) {
  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const debouncedQuery = useDebouncedValue(searchQuery, 300);

  // Helper function to get icon for a token option
  const getTokenIcon = useCallback((option: TokenOption): string | LucideIcon | null => {
    if (option.source === 'database') {
      // For database tokens, use the token type icon
      return getTokenTypeIcon(option.type || 'other');
    } else if (option.source === 'external') {
      if (option.provider === 'finnhub') {
        return getFaviconUrl('https://finnhub.io/');
      } else if (option.provider === 'coingecko') {
        return getFaviconUrl('https://www.coingecko.com/');
      }
    }
    return null;
  }, []);

  // Clear search when opening popover to show all tokens
  useEffect(() => {
    if (open) {
      setSearchQuery('');
    }
  }, [open]);

  // Search tokens using TRPC - only if we don't have suggestedTokens
  const { data: searchResults = [], isFetching: isSearching } = trpc.tokens.search.useQuery(
    { query: debouncedQuery, limit: 20 },
    {
      enabled: debouncedQuery.length >= 1 && !suggestedTokens && open,
      staleTime: 30000, // Cache for 30 seconds
    }
  );

  // Get all tokens for initial display (when no search query and no suggestedTokens)
  const { data: allTokens, isLoading: isLoadingAllTokens } = trpc.tokens.getAll.useQuery();

  // Combine search results with "Create New Token" option
  const options = useMemo((): TokenOption[] => {
    let baseOptions: TokenOption[] = [];

    if (suggestedTokens) {
      // When suggestedTokens are provided, filter them by search query
      baseOptions = suggestedTokens.filter((token) => {
        if (!searchQuery) return true;
        const query = searchQuery.toLowerCase();
        return (
          token.symbol.toLowerCase().includes(query) || token.name.toLowerCase().includes(query)
        );
      });
    } else {
      // Normal search behavior
      baseOptions =
        searchQuery.length >= 1
          ? searchResults.map((token) => ({
              ...token,
              source: token.source as 'database' | 'external',
            }))
          : (allTokens || []).map((token) => ({
              ...token,
              source: 'database' as const,
            }));
    }

    // Add "Create New Token" option only if not restricted to suggestedTokens and allowed
    if (!suggestedTokens && allowCreateNew) {
      const createNewOption: TokenOption = {
        symbol: 'NEW',
        name: 'Create New Token',
        source: 'create-new' as const,
      };
      return [createNewOption, ...baseOptions];
    }

    return baseOptions;
  }, [searchQuery, searchResults, allTokens, suggestedTokens, allowCreateNew]);

  // Find selected option (robust handling for external value format)
  const selectedOption = useMemo(() => {
    if (!value) return undefined;

    if (value === 'new') {
      return options.find((o) => o.source === 'create-new');
    }

    const ext = isExternalTokenValue(value) ? parseExternalTokenValue(value) : null;
    if (ext?.symbol) {
      return options.find(
        (o) => o.source === 'external' && normalizeSymbol(o.symbol) === normalizeSymbol(ext.symbol)
      );
    }

    return options.find((o) => o.id === value);
  }, [value, options]);

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
          buildExternalTokenValue({
            symbol: option.symbol,
            name: option.name,
            provider: option.provider,
            metadata: option.metadata,
            type: option.type || undefined,
          })
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

    if (isExternalTokenValue(value)) {
      const meta = parseExternalTokenValue(value);
      return meta ? `${meta.symbol} - ${meta.name} (External)` : 'External Token';
    }

    if (selectedOption) {
      return `${selectedOption.symbol} - ${selectedOption.name}`;
    }

    return placeholder;
  }, [value, selectedOption, placeholder]);

  return (
    <>
      {isLoadingAllTokens && !suggestedTokens ? (
        <Skeleton className={cn('w-full h-10', className)} />
      ) : (
        <Popover open={open} onOpenChange={setOpen} modal={true}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              role="combobox"
              aria-expanded={open}
              className={cn('w-full justify-between', className)}
              disabled={disabled}
              id={id}
            >
              <div className="flex items-center gap-2 truncate">
                {selectedOption &&
                  (() => {
                    const icon = getTokenIcon(selectedOption);
                    if (typeof icon === 'string') {
                      return (
                        <img
                          src={icon}
                          alt={`${selectedOption.symbol} icon`}
                          className="h-4 w-4 rounded-full object-cover"
                        />
                      );
                    } else if (icon) {
                      const IconComponent = icon;
                      return <IconComponent className="h-4 w-4" />;
                    }
                    return null;
                  })()}
                <span className="truncate">{displayValue}</span>
              </div>
              <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-[400px] p-0" align="start">
            <Command shouldFilter={false}>
              <CommandInput
                placeholder={placeholder}
                value={searchQuery}
                onValueChange={handleSearchChange}
              />
              <CommandList className="max-h-[300px] overflow-y-auto">
                {isSearching && searchQuery.length >= 1 && (
                  <div className="flex items-center justify-center py-4">
                    <LoadingSpinner size="sm" className="mr-2" />
                    <span className="text-sm text-muted-foreground">Searching...</span>
                  </div>
                )}

                {!isSearching && (
                  <>
                    {options.length === 0 && (
                      <CommandEmpty>
                        {debouncedQuery.length >= 1 ? (
                          <div className="py-6 text-center">
                            <p className="text-sm text-muted-foreground mb-2">
                              No tokens found for "{debouncedQuery}"
                            </p>
                            {allowCreateNew && (
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() =>
                                  handleSelect({
                                    symbol: 'NEW',
                                    name: 'Create New Token',
                                    source: 'create-new',
                                  })
                                }
                              >
                                <Plus className="mr-2 h-4 w-4" />
                                Create New Token
                              </Button>
                            )}
                          </div>
                        ) : (
                          'Start typing to search for tokens...'
                        )}
                      </CommandEmpty>
                    )}

                    {options.length > 0 && (
                      <CommandGroup>
                        {options.map((option) => (
                          <CommandItem
                            key={`${option.source}-${option.id || option.symbol}`}
                            value={`${option.symbol} ${option.name}`}
                            onSelect={() => handleSelect(option)}
                            className="flex items-center gap-2 px-2"
                          >
                            {(() => {
                              const icon = getTokenIcon(option);
                              if (typeof icon === 'string') {
                                return (
                                  <img
                                    src={icon}
                                    alt={`${option.symbol} icon`}
                                    className="h-4 w-4 rounded-full object-cover shrink-0"
                                  />
                                );
                              } else if (icon) {
                                const IconComponent = icon;
                                return <IconComponent className="h-4 w-4 shrink-0" />;
                              }
                              return null;
                            })()}
                            <div className="flex flex-col flex-1 min-w-0">
                              <span className="font-medium truncate">{option.symbol}</span>
                              <span className="text-sm text-muted-foreground truncate">
                                {option.name}
                              </span>
                            </div>
                            {option.source === 'external' && (
                              <span className="text-xs text-muted-foreground shrink-0">
                                {option.provider}
                              </span>
                            )}
                            {option.source === 'create-new' && (
                              <Plus className="h-4 w-4 text-muted-foreground shrink-0" />
                            )}
                            <Check
                              className={cn(
                                'h-4 w-4 shrink-0',
                                value ===
                                  (option.id ||
                                    (option.source === 'external'
                                      ? buildExternalTokenValue({
                                          symbol: option.symbol,
                                          name: option.name,
                                          provider: option.provider,
                                          metadata: option.metadata,
                                          type: option.type || undefined,
                                        })
                                      : option.source === 'create-new'
                                        ? 'new'
                                        : ''))
                                  ? 'opacity-100'
                                  : 'opacity-0'
                              )}
                            />
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    )}
                  </>
                )}
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      )}
    </>
  );
}
