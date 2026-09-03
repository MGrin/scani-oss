import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { institutionIconUrl } from '@/lib/icons';
import {
  type MovementHolding,
  matchMovementHoldings,
  movementHoldingAccount,
  movementHoldingLabel,
  movementHoldingSelectedLabel,
} from '../../lib/movement-form';
import { RecordPicker } from '../form/RecordPicker';

/**
 * Which holding moved — searched across institutions, accounts and holdings
 * (SC-619).
 *
 * It was a `<Select>` of every holding the account has, which is a control that
 * asks the reader to recognise a row rather than to name one: on a phone a
 * portfolio of forty rows is a scroll through forty strings of the form
 * `Main · USD`, and the institution — the thing a person actually remembers —
 * appeared nowhere in it.
 *
 * `RecordPicker` is the app's one combobox for a searched field, already the
 * vendor and currency fields on the payment form and the institution field on
 * every capture form. Its docblock states the split this needs: the search is
 * the caller's, the control is the component's. So the search here is local —
 * the holdings list is already loaded for the form, and a round trip to filter
 * an array the client is holding would be slower and offline-fragile.
 *
 * The institution is the row's `leading` favicon AND its `hint`, deliberately
 * both: the mark is what makes a list scannable, and the name is what explains
 * why a row came back when the query was an institution nobody can see on it.
 *
 * The `hint` is dropped when the account name already says the institution
 * (SC-862): an account called `Airwallex` at Airwallex rendered `USD ·
 * Airwallex` with `Airwallex` beside it. The favicon stays either way — a mark
 * is not a repeat of a word.
 */
interface HoldingFieldProps {
  holdings: readonly MovementHolding[];
  value: string;
  onSelect: (holdingId: string) => void;
  disabled?: boolean;
  inputId: string;
}

export function HoldingField({ holdings, value, onSelect, disabled, inputId }: HoldingFieldProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);

  const options = matchMovementHoldings(holdings, query).map((holding) => {
    const favicon = institutionIconUrl(holding.institution);
    return {
      id: holding.id,
      label: movementHoldingLabel(holding),
      hint: movementHoldingAccount(holding).institution ?? undefined,
      leading: favicon ? (
        <img
          src={favicon}
          alt=""
          className="h-4 w-4 shrink-0 rounded-sm object-contain"
          onError={(event) => {
            event.currentTarget.style.display = 'none';
          }}
        />
      ) : undefined,
    };
  });

  const selected = holdings.find((holding) => holding.id === value) ?? null;

  return (
    <RecordPicker
      inputId={inputId}
      ariaLabel={t('v3.holdings.movement.holdingAria')}
      // Not the label `RecordPicker` hands back: a chosen holding is shown
      // alone, with no favicon beside it and no hint to its right, so the one
      // line it gets has to carry the institution too.
      value={selected ? { id: selected.id, label: movementHoldingSelectedLabel(selected) } : null}
      onSelect={(id) => {
        onSelect(id);
        setQuery('');
      }}
      onClear={() => {
        onSelect('');
        setQuery('');
        setOpen(true);
      }}
      query={query}
      onQueryChange={setQuery}
      open={open}
      onOpenChange={setOpen}
      options={options}
      placeholder={t('v3.holdings.movement.holdingPlaceholder')}
      emptyLabel={t('v3.holdings.movement.holdingNoResults')}
      disabled={disabled}
    />
  );
}
