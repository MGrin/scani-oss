import { useDebouncedValue } from '@scani/ui/hooks/useDebouncedValue';
import { showError } from '@scani/ui/ui/use-toast';
import { useState } from 'react';
import { type RouterOutputs, trpc } from '@/lib/trpc';
import { RecordPicker } from '../form/RecordPicker';

/**
 * Which asset a holding is in.
 *
 * Unlike `CurrencyField`, this searches *outward* — `tokens.search` queries our
 * own database and then CoinGecko and Finnhub, and picking an external result
 * materialises it locally before it can be held. That asymmetry is deliberate:
 * naming what a bill is denominated in should never mint a token, while
 * recording that you own something we have never priced obviously has to.
 *
 * The search is debounced at 250ms and only fires with a query, so an open
 * dropdown with an empty field costs nothing and says what to do instead.
 */

type SearchItem = RouterOutputs['tokens']['search'][number];

function sourceLabel(item: SearchItem): string | undefined {
  if (item.source === 'database') return undefined;
  if (item.provider === 'finnhub') return 'Finnhub';
  if (item.provider === 'coingecko') return 'CoinGecko';
  if (item.provider === 'defillama') return 'DeFiLlama';
  return undefined;
}

/** `database:<id>` / `coingecko:BTC` — unique across both sources, and the
 *  string the picker hands back on select, so it has to carry enough to find
 *  the row again. */
function optionId(item: SearchItem): string {
  return item.source === 'database'
    ? `database:${item.id ?? item.symbol}`
    : `${item.provider ?? 'external'}:${item.symbol}`;
}

interface TokenFieldProps {
  value: { id: string; label: string } | null;
  onSelect: (tokenId: string, label: string) => void;
  onClear: () => void;
  disabled?: boolean;
  inputId: string;
  ariaLabel: string;
}

export function TokenField({
  value,
  onSelect,
  onClear,
  disabled,
  inputId,
  ariaLabel,
}: TokenFieldProps) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [materializing, setMaterializing] = useState(false);

  const debounced = useDebouncedValue(query.trim(), 250);
  const search = trpc.tokens.search.useQuery(
    { query: debounced, limit: 12 },
    { enabled: debounced.length > 0, staleTime: 60_000, keepPreviousData: true }
  );
  const createFromExternal = trpc.tokens.createFromExternal.useMutation();

  const results = search.data ?? [];
  const options = results.map((item) => ({
    id: optionId(item),
    label: `${item.symbol} — ${item.name}`,
    hint: sourceLabel(item),
  }));

  const handleSelect = async (id: string, label: string) => {
    const item = results.find((candidate) => optionId(candidate) === id);
    if (!item) return;

    if (item.source === 'database' && item.id) {
      onSelect(item.id, label);
      setQuery('');
      setOpen(false);
      return;
    }

    if (!item.provider || !item.metadata) return;
    if (item.provider === 'defillama') {
      // A DeFiLlama result is a pool, not a token: it has no symbol we can
      // create from without a contract address the search never returns.
      showError('DeFiLlama results need a contract address, so they cannot be added from here.');
      return;
    }

    setMaterializing(true);
    try {
      const created = await createFromExternal.mutateAsync({
        symbol: item.symbol,
        metadata: item.metadata,
        provider: item.provider,
      });
      onSelect(created.id, `${created.symbol} — ${created.name}`);
      setQuery('');
      setOpen(false);
    } catch (error) {
      showError(error instanceof Error ? error.message : 'Adding that token');
    } finally {
      setMaterializing(false);
    }
  };

  return (
    <RecordPicker
      inputId={inputId}
      ariaLabel={ariaLabel}
      value={value}
      onSelect={(id, label) => void handleSelect(id, label)}
      onClear={() => {
        onClear();
        setQuery('');
        setOpen(true);
      }}
      query={query}
      onQueryChange={setQuery}
      open={open}
      onOpenChange={setOpen}
      options={options}
      isLoading={(search.isFetching && results.length === 0) || materializing}
      placeholder="BTC, AAPL, EUR…"
      emptyLabel={
        debounced.length > 0
          ? 'Nothing by that name, here or at our pricing providers.'
          : 'Type a symbol or a name.'
      }
      disabled={disabled}
    />
  );
}
