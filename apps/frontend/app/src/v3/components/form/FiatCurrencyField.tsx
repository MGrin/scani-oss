import type { TFunction } from 'i18next';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type RouterOutputs, trpc } from '@/lib/trpc';
import { tokenDisplayName } from '@/lib/utils';
import { RecordPicker } from './RecordPicker';

/**
 * Pick one of the ~69 seeded fiat currencies — a base currency for the account,
 * a denomination for a vault.
 *
 * NOT `money/CurrencyField`, which searches `tokens.getAll` so a payment can be
 * denominated in anything the database holds, crypto included. A base currency
 * and a savings goal are reported in money a bank issues, so the list here is
 * `users.getSupportedCurrencies` and nothing else can be chosen.
 *
 * v3's own control rather than v2's `FiatCurrencySelect`, and the difference is
 * not decoration: that one is a `Command` inside a Radix `Popover`, so its rows
 * are `div`s at whatever pitch the list gives them. The token layer's
 * coarse-pointer floor keys off `button`, so it never reached them — 69
 * currencies at a 32pt pitch on a phone, which is the defect SC-78 §4 names and
 * `RecordPicker` was built to stop. Its rows are `button`s at `py-3`.
 */

type FiatCurrency = RouterOutputs['users']['getSupportedCurrencies'][number];

/**
 * SC-824. Every row here is fiat BY CONSTRUCTION — the list is
 * `users.getSupportedCurrencies`, which is `TokenService.getTokensByType('fiat')`
 * — so unlike the `getWithDetails` surfaces there is no type to check and no
 * code to carry: `tokenDisplayName` is called with a literal `'fiat'`.
 *
 * `currency.name` is the English prose in `tokens.name`. It is still the
 * fallback inside `tokenDisplayName` for a symbol CLDR does not know, which is
 * why the field is read rather than dropped.
 */
export function fiatCurrencyLabel(
  t: TFunction,
  currency: Pick<FiatCurrency, 'symbol' | 'name'>
): string {
  return `${currency.symbol} — ${fiatCurrencyName(t, currency)}`;
}

function fiatCurrencyName(t: TFunction, currency: Pick<FiatCurrency, 'symbol' | 'name'>): string {
  return tokenDisplayName(t, { ...currency, typeCode: 'fiat' });
}

/**
 * Symbols that start with what was typed, then everything else the term
 * appears in — each band alphabetical by symbol.
 *
 * The two bands are what a plain substring filter gets wrong: typing "r" for
 * the rouble matches "EUR" and "Euro" too, and alphabetically those come
 * first. Nobody types a currency code hoping to find one that merely contains
 * those letters.
 *
 * Uncapped, unlike `CurrencyField`'s twenty. That list is drawn from every
 * token in the database; this one is 69 rows and the picker scrolls, so a cap
 * would only hide currencies without saying so.
 */
export function rankFiatCurrencies(
  t: TFunction,
  currencies: readonly FiatCurrency[],
  query: string
): FiatCurrency[] {
  const term = query.trim().toLowerCase();
  const matches = term
    ? currencies.filter(
        (currency) =>
          currency.symbol.toLowerCase().includes(term) ||
          // The DISPLAYED name, not the stored one: a list that shows
          // `dólar estadounidense` and matches only `US Dollar` cannot find
          // what it is showing.
          fiatCurrencyName(t, currency).toLowerCase().includes(term)
      )
    : [...currencies];

  const band = (currency: FiatCurrency): number =>
    !term || currency.symbol.toLowerCase().startsWith(term) ? 0 : 1;

  return matches.sort((a, b) => band(a) - band(b) || a.symbol.localeCompare(b.symbol));
}

interface FiatCurrencyFieldProps {
  /** The currency's token id, which is what every consumer stores. */
  value: string;
  onChange: (currencyId: string) => void;
  /** Forwarded to the search input so a `<Field>`'s label can focus it. */
  id?: string;
  disabled?: boolean;
  /**
   * Show the chosen currency as its symbol alone.
   *
   * For the half-width slot beside an amount, where the full
   * "USD — US Dollar" has about 80px to render in and truncates to
   * `USD …` — a field that hides the one part of its value that identifies it.
   * The search rows still carry the name; it is only the settled state that
   * drops it, and by then the reader has just chosen the thing.
   */
  compact?: boolean;
}

export function FiatCurrencyField({
  value,
  onChange,
  id,
  disabled,
  compact,
}: FiatCurrencyFieldProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  // "Change" reopens the search WITHOUT unsetting the currency, and that is
  // load-bearing rather than tidy. Both consumers treat this field as
  // required, and Vaults defaults it from the base currency in an effect keyed
  // on the value being empty — so a clear that reached the parent was undone
  // on the same render and the field could not be changed at all. Nothing here
  // ever reports an empty currency; only a chosen one.
  const [changing, setChanging] = useState(false);
  const currencies = trpc.users.getSupportedCurrencies.useQuery();

  const list = currencies.data ?? [];
  const selected = value ? (list.find((currency) => currency.id === value) ?? null) : null;

  return (
    <RecordPicker
      inputId={id}
      ariaLabel={t('v3.form.fiatCurrency.noun')}
      value={
        selected && !changing
          ? { id: selected.id, label: compact ? selected.symbol : fiatCurrencyLabel(t, selected) }
          : null
      }
      onSelect={(currencyId) => {
        onChange(currencyId);
        setChanging(false);
      }}
      onClear={() => {
        setChanging(true);
        setQuery('');
        setOpen(true);
      }}
      query={query}
      onQueryChange={setQuery}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // Closing the list without choosing is a cancel, so the currency that
        // was showing comes back rather than leaving an empty search box.
        if (!next) setChanging(false);
      }}
      options={rankFiatCurrencies(t, list, query).map((currency) => ({
        id: currency.id,
        label: currency.symbol,
        hint: fiatCurrencyName(t, currency),
      }))}
      isLoading={currencies.isLoading}
      placeholder={t('v3.form.fiatCurrency.searchPlaceholder')}
      emptyLabel={t('v3.form.fiatCurrency.empty')}
      // The list is one query for every currency there is; until it lands there
      // is nothing to open and no label to show for a value already set.
      disabled={disabled || currencies.isLoading}
    />
  );
}
