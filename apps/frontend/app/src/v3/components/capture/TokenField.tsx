import { useDebouncedValue } from '@scani/ui/hooks/useDebouncedValue';
import { showError } from '@scani/ui/ui/use-toast';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
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

/** The chosen token's parts, for callers that render the symbol and the name
 *  in separate slots rather than as the one joined label. Splitting the label
 *  back apart on its separator is the alternative, and a token whose name
 *  contains an em dash breaks it. */
export interface TokenSelectionDetails {
  symbol: string;
  name: string;
}

interface TokenFieldProps {
  value: { id: string; label: string } | null;
  onSelect: (tokenId: string, label: string, details: TokenSelectionDetails) => void;
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
  const { t } = useTranslation();
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
      onSelect(item.id, label, { symbol: item.symbol, name: item.name });
      setQuery('');
      setOpen(false);
      return;
    }

    if (!item.provider || !item.metadata) return;
    if (item.provider === 'defillama') {
      // A DeFiLlama result is a pool, not a token: it has no symbol we can
      // create from without a contract address the search never returns.
      showError(t('v3.capture.token.defillamaUnsupported'));
      return;
    }

    setMaterializing(true);
    try {
      const created = await createFromExternal.mutateAsync({
        symbol: item.symbol,
        metadata: item.metadata,
        provider: item.provider,
      });
      onSelect(created.id, `${created.symbol} — ${created.name}`, {
        symbol: created.symbol,
        name: created.name,
      });
      setQuery('');
      setOpen(false);
    } catch (error) {
      // The error itself, with the action as context (SC-311). The previous
      // shape reduced to a string either way, and `showError` discarded every
      // string — so a server rejection and the fallback both rendered as
      // "Unknown error", and `addFailed` ("Adding that token") was never a
      // message anyway. It is a context noun phrase, which is the second slot.
      showError(error, t('v3.capture.token.addFailed'));
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
      placeholder={t('v3.capture.token.searchPlaceholder')}
      emptyLabel={
        debounced.length > 0 ? t('v3.capture.token.noResults') : t('v3.capture.token.prompt')
      }
      disabled={disabled}
    />
  );
}
