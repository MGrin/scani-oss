import { HOLDING_MOVEMENT_DIRECTIONS, type HoldingMovementDirection } from '@scani/shared';
import { Input } from '@scani/ui/ui/input';
import { Segmented, SegmentedItem } from '@scani/ui/ui/segmented';
import { AmountInput } from '@scani/ui/v3/components/AmountInput';
import { useTranslation } from 'react-i18next';
import type { MovementForm } from '../../hooks/useMovementForm';
import { MOVEMENT_OUTFLOW_OPTIONS, type MovementHolding } from '../../lib/movement-form';
import { AccountTargetFields } from '../capture/AccountTargetFields';
import { DateField } from '../form/DateField';
import { Field } from '../form/Field';
import { HoldingField } from './HoldingField';

/**
 * The movement form's fields, apart from whatever frames them (SC-619).
 *
 * Two exports rather than one because the page puts each in its own `<Block>`
 * and the second one is conditional — an inflow is not asked where it went.
 * The dialog renders both in sequence. Neither owns any state: that is
 * `useMovementForm`, held by whichever surface also owns the submit button.
 *
 * Every control is a `<Field>` — 14px label over a 16px control — rather than
 * the hand-rolled `<Label>` pairs this replaced. That is not tidying: below
 * 16px Safari zooms the page on focus, and this form is reached from a phone
 * more than from anything else.
 */

interface MovementFieldsProps {
  form: MovementForm;
  /** Fixed when opened from a holding's own sheet; null shows the picker. */
  holding: MovementHolding | null;
  holdings: readonly MovementHolding[];
  disabled: boolean;
}

export function MovementWhatFields({ form, holding, holdings, disabled }: MovementFieldsProps) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-4">
      {holding ? null : (
        <Field label={t('v3.holdings.movement.holdingLabel')} htmlFor="movement-holding">
          <HoldingField
            inputId="movement-holding"
            holdings={holdings}
            value={form.holdingId}
            onSelect={form.selectHolding}
            disabled={disabled}
          />
        </Field>
      )}

      <Field label={t('v3.holdings.movement.directionLabel')}>
        <Segmented
          value={form.direction}
          onValueChange={(next) => form.chooseDirection(next as HoldingMovementDirection)}
          aria-label={t('v3.holdings.movement.directionLabel')}
        >
          {HOLDING_MOVEMENT_DIRECTIONS.map((option) => (
            <SegmentedItem key={option} value={option}>
              {t(`v3.holdings.movement.direction.${option}`)}
            </SegmentedItem>
          ))}
        </Segmented>
      </Field>

      <Field
        label={t('v3.holdings.movement.amountLabel', { symbol: form.selected?.token.symbol ?? '' })}
        htmlFor="movement-amount"
        hint={
          form.selected
            ? t('v3.holdings.movement.currentBalance', {
                amount: form.selected.amount,
                symbol: form.selected.token.symbol,
              })
            : undefined
        }
      >
        <AmountInput
          id="movement-amount"
          value={form.amount}
          onValueChange={form.setAmount}
          className="text-body"
          disabled={disabled}
          // Only where the holding is already known. On the page the picker is
          // the first field, and opening the keyboard over it would put the
          // caret past the question being asked.
          autoFocus={Boolean(holding)}
        />
      </Field>

      {/* A wire leaves one amount and arrives as another, and until SC-889 the
          movement form had no way to say so — it wrote the sent amount to both
          legs. Directly under the amount it is carved out of, and only on a
          transfer: an inflow has no second leg for a fee to be the difference
          between, and an outflow says the money left the portfolio. */}
      {form.direction === 'transfer' ? (
        <Field
          label={t('v3.holdings.fee.label')}
          htmlFor="movement-fee"
          // Three readings, because two would leave the reassuring one — "leave
          // empty if nothing was charged" — sitting under a field that is
          // actively disabling Save. The blocker list at the foot of the form
          // says the same thing; this says it where the number is.
          hint={
            form.feeArrives !== null
              ? t('v3.holdings.fee.arrives', {
                  amount: form.feeArrives,
                  symbol: form.selected?.token.symbol ?? '',
                })
              : form.feeBlocked
                ? t('v3.holdings.fee.tooLarge')
                : t('v3.holdings.fee.explain')
          }
        >
          <AmountInput
            id="movement-fee"
            value={form.fee}
            onValueChange={form.setFee}
            className="text-body"
            disabled={disabled}
          />
        </Field>
      ) : null}

      <Field label={t('v3.holdings.movement.dateLabel')} htmlFor="movement-date">
        <DateField id="movement-date" value={form.date} onChange={form.setDate} />
      </Field>

      <Field label={t('v3.holdings.movement.noteLabel')} htmlFor="movement-note">
        <Input
          id="movement-note"
          value={form.note}
          onChange={(event) => form.setNote(event.target.value)}
          maxLength={500}
          className="text-body"
          disabled={disabled}
        />
      </Field>
    </div>
  );
}

/**
 * "Where did it go?" — the question that keeps the recorded outflow out of the
 * transfer-review queue, and the transfer destination when the answer is
 * another account.
 */
export function MovementWhereFields({
  form,
  disabled,
}: Omit<MovementFieldsProps, 'holding' | 'holdings'>) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-4">
      <fieldset className="flex flex-col gap-2">
        <legend className="pb-2 text-label text-muted-foreground">
          {t('v3.holdings.movement.whereLabel')}
        </legend>
        {MOVEMENT_OUTFLOW_OPTIONS.map((option) => (
          <label
            key={option}
            className={`flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border p-3 ${
              form.destination === option
                ? 'border-primary bg-primary/5'
                : 'border-border bg-surface-1 hover:bg-surface-hover'
            }`}
          >
            <input
              type="radio"
              name="movement-destination"
              className="mt-1"
              checked={form.destination === option}
              disabled={disabled}
              onChange={() => form.chooseDestination(option)}
            />
            <span className="flex flex-col gap-0.5">
              <span className="text-body">{t(`v3.holdings.movement.where.${option}.title`)}</span>
              <span className="text-caption text-muted-foreground">
                {t(`v3.holdings.movement.where.${option}.detail`)}
              </span>
            </span>
          </label>
        ))}
      </fieldset>

      {form.direction === 'transfer' ? (
        <AccountTargetFields
          target={form.accountTarget}
          disabled={disabled}
          title={t('v3.holdings.movement.destinationTitle')}
        />
      ) : null}
    </div>
  );
}
