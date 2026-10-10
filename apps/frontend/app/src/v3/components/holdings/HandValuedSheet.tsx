import type { HandValuedDirection } from '@scani/shared';
import { Segmented, SegmentedItem } from '@scani/ui/ui/segmented';
import { AmountInput } from '@scani/ui/v3/components/AmountInput';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { parsePositivePrice } from '../../lib/custom-tokens';
import { HAND_VALUED_MONEY_SCALE } from '../../lib/hand-valued';
import { DateField, todayIso } from '../form/DateField';
import { Field } from '../form/Field';
import { FormActions, FormSheet } from '../form/FormSheet';

export type HandValuedMode = 'value' | 'money';

interface HandValuedSheetProps {
  mode: HandValuedMode;
  onOpenChange: (open: boolean) => void;
  /** The currency every amount here is typed in — the reader's base currency. */
  currency: string;
  isSaving: boolean;
  error: string | null;
  onSubmitValue: (draft: { value: string; date: string }) => void;
  onSubmitMoney: (draft: { direction: HandValuedDirection; amount: string; date: string }) => void;
}

/**
 * Update the value of, or move money into or out of, a hand-valued holding
 * (SC-1596). Two forms on one frame, opened as two different actions, because
 * which one applies is the one decision the owner has to make: did the
 * investment grow, or did money move? The description under each title says
 * which, in those words.
 */
export function HandValuedSheet({
  mode,
  onOpenChange,
  currency,
  isSaving,
  error,
  onSubmitValue,
  onSubmitMoney,
}: HandValuedSheetProps) {
  const { t } = useTranslation();
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(todayIso());
  const [direction, setDirection] = useState<HandValuedDirection>('in');
  const key = mode === 'value' ? 'updateValue' : 'money';

  const blockers = [
    ...(parsePositivePrice(amount) === null ? [t('v3.holdings.handValued.blocker.amount')] : []),
    ...(date === '' ? [t('v3.holdings.handValued.blocker.date')] : []),
  ];

  const submit = () => {
    if (blockers.length > 0) return;
    if (mode === 'value') onSubmitValue({ value: amount, date });
    else onSubmitMoney({ direction, amount, date });
  };

  return (
    <FormSheet
      open
      onOpenChange={onOpenChange}
      title={t(`v3.holdings.handValued.${key}.title`)}
      description={t(`v3.holdings.handValued.${key}.description`)}
      footer={
        <FormActions
          submitLabel={t(`v3.holdings.handValued.${key}.save`)}
          pendingLabel={t(`v3.holdings.handValued.${key}.saving`)}
          onSubmit={submit}
          onCancel={() => onOpenChange(false)}
          blockers={blockers}
          pending={isSaving}
          error={error}
        />
      }
    >
      <div className="flex flex-col gap-4">
        {mode === 'money' ? (
          <Field label={t('v3.holdings.movement.directionLabel')}>
            <Segmented
              value={direction}
              onValueChange={(next) => setDirection(next as HandValuedDirection)}
              aria-label={t('v3.holdings.movement.directionLabel')}
            >
              <SegmentedItem value="in">
                {t('v3.holdings.handValued.money.direction.in')}
              </SegmentedItem>
              <SegmentedItem value="out">
                {t('v3.holdings.handValued.money.direction.out')}
              </SegmentedItem>
            </Segmented>
          </Field>
        ) : null}

        <Field
          label={t(
            mode === 'value'
              ? 'v3.holdings.handValued.updateValue.valueLabel'
              : 'v3.holdings.handValued.money.amountLabel',
            { currency }
          )}
          htmlFor="hand-valued-amount"
        >
          <AmountInput
            id="hand-valued-amount"
            value={amount}
            onValueChange={setAmount}
            decimalScale={HAND_VALUED_MONEY_SCALE}
            className="text-body"
            disabled={isSaving}
            autoFocus
          />
        </Field>

        <Field label={t(`v3.holdings.handValued.${key}.dateLabel`)} htmlFor="hand-valued-date">
          <DateField id="hand-valued-date" value={date} onChange={setDate} />
        </Field>
      </div>
    </FormSheet>
  );
}
