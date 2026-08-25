import { Button } from '@scani/ui/ui/button';
import { AmountInput } from '@scani/ui/v3/components/AmountInput';
import { Block } from '@scani/ui/v3/components/Block';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { RouterOutputs } from '@/lib/trpc';
import type { Affordability, OneOffOutflow } from '../../lib/forecast';
import { todayDateString } from '../../lib/paymentTotals';
import { DateField } from '../form/DateField';
import { Field, FieldRow, FieldSet } from '../form/Field';
import { CurrencyPicker } from './CurrencyField';
import { ProjectedTile } from './ProjectedTile';
import { formatProjectionMonth } from './ProjectionChart';

/**
 * "Can I afford X" — SC-461's third scope item, and the only control on the
 * Money tab that asks a question instead of recording a fact.
 *
 * ## Why it writes nothing
 *
 * A one-off is not a payment. It has no vendor, no cadence and no obligation
 * behind it; it is a hypothesis the reader is holding for as long as they are
 * looking at the screen. Persisting it would put a row in `payments` that the
 * recurring list then has to explain, and settling or pausing it would mean
 * nothing. So the answer is computed client-side from the projection already
 * in hand — no round trip, no record, and it is gone on navigation, which is
 * the correct lifetime for a hypothesis.
 *
 * ## The fields are the form conventions, not new ones
 *
 * `AmountInput`, `CurrencyField` and `DateField` are what `PaymentFormPage`
 * uses for the same three values, which matters more than it sounds: this is a
 * reading surface that grew a capture control, and SC-619 landed hours before
 * this ticket for exactly the failure of inventing a shape here. `CurrencyField`
 * is `RecordPicker` underneath — the one combobox for a searched field.
 *
 * ## What the answer says
 *
 * Not "yes" or "no". A purchase that leaves the balance above zero is still one
 * that costs months of runway, and both facts are printed: the low point the
 * balance reaches and what the runway becomes. `affordability()` returns
 * `monthsLost: null` rather than a number whenever the two runways are not
 * comparable, and this prints the two answers instead of inventing a
 * difference.
 */

interface AffordabilityPanelProps {
  oneOff: OneOffOutflow | null;
  onChange: (next: OneOffOutflow | null) => void;
  verdict: Affordability | null;
  baseSymbol: string;
  /** Currencies to pick from, handed down rather than fetched — this surface
   *  stays free of tRPC so it can be rendered and asserted on its own. */
  tokens: readonly RouterOutputs['tokens']['getAll'][number][];
  /** The rates have not landed, so any answer would be computed on a burn that
   *  is missing its foreign half. */
  disabled?: boolean;
}

export function AffordabilityPanel({
  oneOff,
  onChange,
  verdict,
  baseSymbol,
  tokens,
  disabled = false,
}: AffordabilityPanelProps) {
  const { t } = useTranslation();
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState<{ id: string; label: string } | null>(null);
  const [date, setDate] = useState(todayDateString());

  const ready = amount.trim() !== '' && Number(amount) > 0 && currency !== null && date !== '';

  const ask = () => {
    if (!ready || !currency) return;
    onChange({ date, currencyTokenId: currency.id, amount });
  };

  return (
    <Block className="flex flex-col gap-4 border-dashed p-4">
      <FieldSet title={t('v3.money.forecast.affordTitle')}>
        <FieldRow>
          <Field label={t('v3.money.forecast.affordAmount')} htmlFor="afford-amount">
            <AmountInput
              id="afford-amount"
              value={amount}
              onValueChange={setAmount}
              placeholder="0.00"
              decimalScale={2}
              disabled={disabled}
              className="text-body"
            />
          </Field>
          <CurrencyPicker
            inputId="afford-currency"
            value={currency}
            onSelect={(tokenId, label) => setCurrency({ id: tokenId, label })}
            onClear={() => setCurrency(null)}
            tokens={tokens}
            disabled={disabled}
          />
        </FieldRow>
        <Field label={t('v3.money.forecast.affordWhen')} htmlFor="afford-date">
          <DateField id="afford-date" value={date} onChange={setDate} disabled={disabled} />
        </Field>
      </FieldSet>

      <div className="flex flex-wrap gap-2">
        {/* Not a live recompute on every keystroke: the answer is a whole
            paragraph that would rewrite itself under the reader's hand while
            they are still typing the amount, and a figure that changes as you
            look at it is the one thing a projection cannot afford to do. */}
        <Button onClick={ask} disabled={disabled || !ready}>
          {t('v3.money.forecast.affordAsk')}
        </Button>
        {oneOff ? (
          <Button variant="outline" onClick={() => onChange(null)}>
            {t('v3.money.forecast.affordClear')}
          </Button>
        ) : null}
      </div>

      {verdict ? <AffordabilityAnswer verdict={verdict} baseSymbol={baseSymbol} /> : null}
    </Block>
  );
}

function AffordabilityAnswer({
  verdict,
  baseSymbol,
}: {
  verdict: Affordability;
  baseSymbol: string;
}) {
  const { t } = useTranslation();
  const lowest = <Numeric value={verdict.lowest.balance.toString()} currency={baseSymbol} />;

  return (
    <div className="flex flex-col gap-2 border-t border-dashed border-border pt-4">
      <ProjectedTile
        label={t('v3.money.forecast.affordLowest')}
        value={lowest}
        note={
          verdict.lowest.month
            ? t('v3.money.forecast.affordLowestIn', {
                month: formatProjectionMonth(verdict.lowest.month),
              })
            : t('v3.money.forecast.affordLowestNow')
        }
      />

      {/* The verdict is never a bare yes. "You can afford it" over a purchase
          that costs four months of runway is true and useless. */}
      <p className="text-caption text-muted-foreground">
        {verdict.affordable
          ? t('v3.money.forecast.affordStaysPositive')
          : t('v3.money.forecast.affordGoesNegative')}
      </p>

      {verdict.monthsLost !== null && verdict.monthsLost > 0 ? (
        <p className="text-caption text-muted-foreground">
          {t('v3.money.forecast.affordCostsMonths', { count: verdict.monthsLost })}
        </p>
      ) : null}

      {verdict.runwayAfter.kind === 'exhausted' ? (
        <p className="text-caption text-muted-foreground">
          {t('v3.money.forecast.affordRunwayAfter', {
            month: formatProjectionMonth(verdict.runwayAfter.month),
          })}
        </p>
      ) : (
        <p className="text-caption text-muted-foreground">
          {t('v3.money.forecast.affordRunwayStillBeyond', {
            count: verdict.runwayAfter.beyondMonths,
          })}
        </p>
      )}
    </div>
  );
}
