import type { TFunction } from 'i18next';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type RouterOutputs, trpc } from '@/lib/trpc';
import { tokenDisplayName } from '@/lib/utils';
import { tokenTypeLabel } from '../../lib/tokens';
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

/** `tokens.getAll` calls the CODE `type`, so that is what the helper's
 *  `typeCode` gets — see `tokenDisplayName` on why the name is not `type`. */
export function tokenLabel(
  t: TFunction,
  token: Pick<TokenRow, 'symbol' | 'name'> & { type?: string | null }
): string {
  return `${token.symbol} — ${tokenDisplayName(t, { ...token, typeCode: token.type })}`;
}

/** Exact symbol, then fiat, then the rest — each band alphabetical by symbol. */
export function rankCurrencyMatches(
  t: TFunction,
  tokens: readonly TokenRow[],
  query: string
): TokenRow[] {
  const term = query.trim().toLowerCase();
  const matches = term
    ? tokens.filter(
        (token) =>
          token.symbol.toLowerCase().includes(term) ||
          // Match what the row SHOWS. A picker listing `dólar estadounidense`
          // that only matches `United States Dollar` is a filter that finds
          // nothing a Spanish reader can see (SC-419).
          tokenDisplayName(t, { ...token, typeCode: token.type })
            .toLowerCase()
            .includes(term)
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

interface CurrencyPickerProps {
  value: { id: string; label: string } | null;
  onSelect: (tokenId: string, label: string) => void;
  onClear: () => void;
  /** The currencies to rank, handed in rather than fetched — see below. */
  tokens: readonly TokenRow[];
  isLoading?: boolean;
  /** Unique per surface: two of these on one page would share a label. */
  inputId?: string;
  disabled?: boolean;
}

/**
 * The field without the query.
 *
 * v3's view components stay free of tRPC so they remain renderable — and
 * therefore assertable — on their own; `MoneyPage`'s own comment says so about
 * its three view components. The Forecast view (SC-461) needs a currency slot
 * on a surface built to that rule, so the query moves out to the one caller
 * that does not already hold the token list, and everything else — the
 * ranking, the picker, the labels — is shared rather than copied.
 */
export function CurrencyPicker({
  value,
  onSelect,
  onClear,
  tokens,
  isLoading = false,
  inputId = 'payment-currency',
  disabled,
}: CurrencyPickerProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);

  const options = rankCurrencyMatches(t, tokens, query).map((token) => ({
    id: token.id,
    label: tokenLabel(t, token),
    // Fiat carries no hint: the label already reads "EUR — Euro", and
    // "Fiat Currency" under every row of a currency picker is noise.
    hint:
      token.type === 'fiat'
        ? undefined
        : tokenTypeLabel(t, token.type, token.typeName) || undefined,
  }));

  return (
    <Field label={t('v3.money.currencyField.label')} htmlFor={inputId}>
      <RecordPicker
        inputId={inputId}
        // NOT extracted: `RecordPicker` renders `Change ${ariaLabel}`, so this
        // is a noun fragment inside a frame the caller cannot see. Same class
        // as `noun` was before SC-257, and the same fix — a key plus a frame
        // key on the picker. SC-235.
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
        isLoading={isLoading}
        placeholder={t('v3.money.currencyField.searchPlaceholder')}
        emptyLabel={t('v3.money.currencyField.empty')}
        disabled={disabled}
      />
    </Field>
  );
}

interface CurrencyFieldProps {
  value: { id: string; label: string } | null;
  onSelect: (tokenId: string, label: string) => void;
  onClear: () => void;
  disabled?: boolean;
}

/** `<CurrencyPicker>` with the token query attached — what the payment form
 *  uses, since it holds no token list of its own. */
export function CurrencyField(props: CurrencyFieldProps) {
  const tokens = trpc.tokens.getAll.useQuery();
  return <CurrencyPicker {...props} tokens={tokens.data ?? []} isLoading={tokens.isLoading} />;
}
