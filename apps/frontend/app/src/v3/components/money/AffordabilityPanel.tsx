import type { ObservedAffordability } from '@scani/shared';
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
  /**
   * The answer that ships (SC-661, mgrin). When present it REPLACES `verdict`
   * rather than sitting beside it — two answers to "can I afford it" on one
   * panel is the contradiction this ticket exists to remove, one screen further
   * in. `verdict` remains for the account that has a recurring book and no
   * perimeter exits, where the walk is the only answer there is.
   */
  observedVerdict: ObservedAffordability | null;
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
  observedVerdict,
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

      {observedVerdict ? (
        <ObservedAffordabilityAnswer verdict={observedVerdict} baseSymbol={baseSymbol} />
      ) : verdict ? (
        <AffordabilityAnswer verdict={verdict} baseSymbol={baseSymbol} />
      ) : null}
    </Block>
  );
}

/**
 * The answer against observed burn (SC-661).
 *
 * ## What it cannot say, stated because it used to
 *
 * There is no month here. The committed walk put the one-off in a dated bucket
 * and could name the month the balance dips, because the book carries dates.
 * Observed burn is a mean over six complete months and has no schedule, so a
 * purchase today and the same purchase in October cost exactly the same. That
 * is a real thing given up and the surface says so rather than letting the
 * reader assume the date field still means something to the answer.
 *
 * ## What it can say, which it could not before
 *
 * A cost in months, always. The walk returned `monthsLost: null` unless BOTH
 * projections ran out inside twelve months, and on a book that nets +$10.8k a
 * month neither ever did — so the panel answered "affordable" to everything.
 */
function ObservedAffordabilityAnswer({
  verdict,
  baseSymbol,
}: {
  verdict: ObservedAffordability;
  baseSymbol: string;
}) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-2 border-t border-dashed border-border pt-4">
      <ProjectedTile
        label={t('v3.money.forecast.affordRemaining')}
        value={<Numeric value={verdict.remaining.toString()} currency={baseSymbol} />}
        note={t('v3.money.forecast.affordRunwayAfterObserved', { count: verdict.monthsAfter })}
      />

      {verdict.affordable ? null : (
        <p className="text-caption text-muted-foreground">{t('v3.money.forecast.affordCannot')}</p>
      )}

      {verdict.monthsLost > 0 ? (
        <p className="text-caption text-muted-foreground">
          {t('v3.money.forecast.affordCostsMonths', { count: verdict.monthsLost })}
        </p>
      ) : null}

      {/* The date field above is still collected — it is part of the form's
          shape and a reader fills it in — but it does not reach this answer.
          Saying so is cheaper than a reader concluding the timing was
          considered. */}
      <p className="text-caption text-muted-foreground">
        {t('v3.money.forecast.affordNoSchedule')}
      </p>
    </div>
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
