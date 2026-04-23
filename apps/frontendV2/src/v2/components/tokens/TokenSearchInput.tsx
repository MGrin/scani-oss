import { Loader2, Plus } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { showError } from '@/hooks/use-toast';
import { type RouterOutputs, trpc } from '@/lib/trpc';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { CreateCustomTokenDialog } from './CreateCustomTokenDialog';

export interface TokenSelectionValue {
  id: string;
  label: string;
}

interface TokenSearchInputProps {
  value: TokenSelectionValue | null;
  label?: string;
  onSelect: (id: string, label: string) => void;
  onClear: () => void;
  disabled?: boolean;
  placeholder?: string;
}

type SearchItem = RouterOutputs['tokens']['search'][number];

function sourceLabel(provider: SearchItem['provider']): string | null {
  if (provider === 'finnhub') return 'Finnhub';
  if (provider === 'coingecko') return 'CoinGecko';
  if (provider === 'defillama') return 'DeFiLlama';
  return null;
}

export function TokenSearchInput({
  value,
  label,
  onSelect,
  onClear,
  disabled,
  placeholder = 'Search tokens (BTC, USD, AAPL...)',
}: TokenSearchInputProps) {
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [materializingKey, setMaterializingKey] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const debouncedSearch = useDebouncedValue(search.trim(), 250);
  const hasQuery = debouncedSearch.length > 0;

  const searchQuery = trpc.tokens.search.useQuery(
    { query: debouncedSearch, limit: 12 },
    {
      enabled: hasQuery,
      staleTime: 60_000,
      keepPreviousData: true,
    }
  );

  const createFromExternal = trpc.tokens.createFromExternal.useMutation();

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const results = useMemo(() => searchQuery.data ?? [], [searchQuery.data]);

  const handlePick = async (item: SearchItem) => {
    if (item.source === 'database' && item.id) {
      onSelect(item.id, `${item.symbol} — ${item.name}`);
      setSearch('');
      setOpen(false);
      return;
    }

    // External result — materialise it in our DB first.
    if (item.source === 'external' && item.provider && item.metadata) {
      if (item.provider === 'defillama') {
        showError('DeFiLlama tokens require a contract address and cannot be created this way.');
        return;
      }
      const key = `${item.provider}:${item.symbol}`;
      setMaterializingKey(key);
      try {
        const created = await createFromExternal.mutateAsync({
          symbol: item.symbol,
          metadata: item.metadata,
          provider: item.provider,
        });
        onSelect(created.id, `${created.symbol} — ${created.name}`);
        setSearch('');
        setOpen(false);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to create token';
        showError(message);
      } finally {
        setMaterializingKey(null);
      }
    }
  };

  if (value) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium px-3 py-2 border rounded-md flex-1 bg-muted truncate">
          {value.label}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 text-xs shrink-0"
          onClick={onClear}
          disabled={disabled}
        >
          Change
        </Button>
      </div>
    );
  }

  return (
    <div className="relative" ref={containerRef}>
      {label && <Label className="text-xs mb-1 block">{label}</Label>}
      <Input
        value={search}
        onChange={(e) => {
          setSearch(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        placeholder={placeholder}
        disabled={disabled}
      />
      {open && (
        <div className="absolute z-20 mt-1 w-full bg-popover border rounded-md shadow-lg max-h-[320px] overflow-y-auto">
          <button
            type="button"
            className="w-full text-left px-3 py-2 text-sm text-primary hover:bg-accent flex items-center gap-2 border-b"
            onClick={() => {
              setCreateOpen(true);
              setOpen(false);
            }}
          >
            <Plus className="h-3.5 w-3.5" />
            Create custom token
          </button>

          {!hasQuery && (
            <p className="px-3 py-2 text-xs text-muted-foreground">
              Type to search tokens across our database and pricing providers.
            </p>
          )}

          {hasQuery && searchQuery.isFetching && results.length === 0 && (
            <p className="px-3 py-2 text-xs text-muted-foreground flex items-center gap-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Searching…
            </p>
          )}

          {hasQuery &&
            results.map((item) => {
              const key = `${item.source}:${item.provider ?? 'db'}:${item.symbol}:${item.id ?? ''}`;
              const source = sourceLabel(item.provider);
              const isMaterializing =
                item.source === 'external' &&
                materializingKey === `${item.provider}:${item.symbol}`;
              return (
                <button
                  type="button"
                  key={key}
                  className="w-full text-left px-3 py-2 text-sm hover:bg-accent flex items-center gap-2 disabled:opacity-50"
                  onClick={() => handlePick(item)}
                  disabled={isMaterializing || createFromExternal.isPending}
                >
                  {item.iconUrl ? (
                    <img
                      src={item.iconUrl}
                      alt=""
                      className="h-4 w-4 rounded-sm object-contain"
                      onError={(e) => {
                        (e.target as HTMLImageElement).style.display = 'none';
                      }}
                    />
                  ) : null}
                  <span className="font-medium w-16 truncate">{item.symbol}</span>
                  <span className="text-muted-foreground text-xs truncate flex-1">{item.name}</span>
                  {(item.typeName || item.type) && (
                    <Badge variant="secondary" className="shrink-0 capitalize">
                      {item.typeName ?? item.type}
                    </Badge>
                  )}
                  {item.source === 'external' && source && (
                    <Badge variant="outline" className="shrink-0">
                      from {source}
                    </Badge>
                  )}
                  {isMaterializing && <Loader2 className="h-3.5 w-3.5 animate-spin shrink-0" />}
                </button>
              );
            })}

          {hasQuery && !searchQuery.isFetching && results.length === 0 && (
            <p className="px-3 py-2 text-xs text-muted-foreground">
              No tokens found for "{debouncedSearch}". You can still create a custom token above.
            </p>
          )}
        </div>
      )}

      <CreateCustomTokenDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        initialSymbol={search.trim() || undefined}
        onCreated={(token) => {
          onSelect(token.id, `${token.symbol} — ${token.name}`);
          setSearch('');
        }}
      />
    </div>
  );
}
