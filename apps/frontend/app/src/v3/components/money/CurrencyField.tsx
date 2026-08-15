import { useState } from 'react';
import { type RouterOutputs, trpc } from '@/lib/trpc';
import { Field } from '../form/Field';
import { RecordPicker } from '../form/RecordPicker';

/**
 * What the payment is denominated in.
 *
 * A local search over `tokens.getAll` rather than v2's `TokenSearchInput`,
 * which searches CoinGecko and Finnhub live and can materialise a token that
 * does not exist in our database yet. That belongs on a token surface, not on a
 * bill's currency slot: bringing a brand-new external asset into the database
 * as a side effect of naming a monthly invoice is a write nobody asked for, and
 * it is most of why that field is 160 lines of the v2 form. Anything already in
 * the database — every seeded fiat currency, every token the user holds — is
 * pickable here.
 *
 * Fiat leads the results because a recurring bill is denominated in a currency
 * far more often than in a token, and an exact symbol match leads everything:
 * typing "USD" must not put "USDC" first.
 */

type TokenRow = RouterOutputs['tokens']['getAll'][number];

/** Enough to scan, few enough that the list does not become the page. */
const MAX_RESULTS = 20;

export function tokenLabel(token: Pick<TokenRow, 'symbol' | 'name'>): string {
  return `${token.symbol} — ${token.name}`;
}

/** Exact symbol, then fiat, then the rest — each band alphabetical by symbol. */
export function rankCurrencyMatches(tokens: readonly TokenRow[], query: string): TokenRow[] {
  const term = query.trim().toLowerCase();
  const matches = term
    ? tokens.filter(
        (token) =>
          token.symbol.toLowerCase().includes(term) || token.name.toLowerCase().includes(term)
      )
    : tokens.filter((token) => token.type === 'fiat');

  const band = (token: TokenRow): number => {
    if (term && token.symbol.toLowerCase() === term) return 0;
    return token.type === 'fiat' ? 1 : 2;
  };

  return [...matches]
    .sort((a, b) => band(a) - band(b) || a.symbol.localeCompare(b.symbol))
    .slice(0, MAX_RESULTS);
}

interface CurrencyFieldProps {
  value: { id: string; label: string } | null;
  onSelect: (tokenId: string, label: string) => void;
  onClear: () => void;
  disabled?: boolean;
}

export function CurrencyField({ value, onSelect, onClear, disabled }: CurrencyFieldProps) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const tokens = trpc.tokens.getAll.useQuery();

  const options = rankCurrencyMatches(tokens.data ?? [], query).map((token) => ({
    id: token.id,
    label: tokenLabel(token),
    hint: token.type === 'fiat' ? undefined : (token.typeName ?? undefined),
  }));

  return (
    <Field label="Currency" htmlFor="payment-currency">
      <RecordPicker
        inputId="payment-currency"
        ariaLabel="currency"
        value={value}
        onSelect={onSelect}
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
        isLoading={tokens.isLoading}
        placeholder="USD, EUR, BTC…"
        emptyLabel="Nothing in your token list matches that."
        disabled={disabled}
      />
    </Field>
  );
}
