import {
  Decimal,
  HOLDING_LABEL_MAX_LENGTH,
  type HoldingWithDetails,
  manualEditNeedsCause,
} from '@scani/shared';
import { Input } from '@scani/ui/ui/input';
import { AmountInput } from '@scani/ui/v3/components/AmountInput';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BALANCE_EDIT_SCALE,
  balanceEditWrites,
  balanceFromEditor,
  holdingOwes,
  seedForEditor,
} from '../../lib/holdings';
import { Field } from '../form/Field';
import { FormActions, FormSheet } from '../form/FormSheet';
import { type HoldingEditCauseAnswer, useHoldingEditCause } from './HoldingEditCause';

export interface HoldingEdit {
  balance?: string;
  /** `null` clears the pot's name; omitted leaves it. */
  label?: string | null;
}

/**
 * A holding's amount and pot name, edited the way every record is (UI standard
 * rule 13, SC-1436): an Edit action in the peek opens this `FormSheet`.
 *
 * Both used to be pencils in the peek's facts that swapped the figure for an
 * input and a Save button in place (SC-564, SC-567). That made a holding the
 * one record in the app edited unlike a bill, a group or a vault, and the
 * cause question it can raise opened as a second sheet stacked over the peek.
 * The question is a section of this sheet now, shown the moment the amount
 * changes on a holding that needs it (`manualEditNeedsCause`), so the edit and
 * its meaning are one submit.
 *
 * Mounted only while a holding is targeted and keyed on it, so the fields and
 * the cause answer are seeded once from the holding it was opened for.
 */
export function EditHoldingSheet({
  holding,
  showPot,
  onOpenChange,
  onSave,
}: {
  holding: HoldingWithDetails;
  /** Whether the pot name applies: the row has one, or shares its (account,
   *  token) with a sibling it needs telling apart from (SC-330). */
  showPot: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (edit: HoldingEdit & Partial<HoldingEditCauseAnswer>) => void;
}) {
  const { t } = useTranslation();
  const holdingLabel = holding.label ?? holding.token.symbol;
  // `amount` itself, never `String(...)` of a number: `String(4.013e-10)` is an
  // exponent the field's parser does not read (SC-567).
  // A loan or card shows what is owed, positive (SC-1640).
  const owes = holdingOwes(holding);
  const [amount, setAmount] = useState(() => seedForEditor(holding, holding.amount));
  const [label, setLabel] = useState(holding.label ?? '');

  // `balanceEditWrites` is what keeps opening and saving a dust balance from
  // writing a rounded figure over it (SC-567): no keystroke, no write.
  const balance = balanceFromEditor(holding, amount);
  const amountChanged = balanceEditWrites(holding.amount, balance);
  const nextLabel = label.trim() ? label.trim() : null;
  const labelChanged = showPot && nextLabel !== (holding.label ?? null);
  // An owed edit is a correction, with nothing to ask (feeds, SC-1640 F2).
  const asksCause = amountChanged && !owes && manualEditNeedsCause(holding.token.typeCode);
  const isOutflow = amountChanged && new Decimal(balance).lt(holding.amount);

  const cause = useHoldingEditCause({
    holdingLabel,
    holdingId: holding.id,
    tokenSymbol: holding.token.symbol,
    isOutflow,
    // What left, unsigned — the bound a stated fee has to fit inside (SC-857).
    outflowQuantity: isOutflow ? new Decimal(holding.amount).minus(balance).toString() : undefined,
    defaultCause: holding.manualEditCause ?? null,
  });

  const blockers = asksCause ? cause.blockers : [];

  const submit = () => {
    if (blockers.length > 0) return;
    if (!amountChanged && !labelChanged) {
      onOpenChange(false);
      return;
    }
    onSave({
      ...(amountChanged ? { balance } : {}),
      ...(labelChanged ? { label: nextLabel } : {}),
      ...(asksCause ? cause.answer() : {}),
      ...(amountChanged && owes ? { editCause: 'correction' as const } : {}),
    });
    onOpenChange(false);
  };

  return (
    <FormSheet
      open
      onOpenChange={onOpenChange}
      title={t('v3.holdings.edit.title')}
      description={t('v3.holdings.edit.description')}
      footer={
        <FormActions
          submitLabel={t('v3.form.saveChanges')}
          pendingLabel={t('v3.form.saving')}
          onSubmit={submit}
          onCancel={() => onOpenChange(false)}
          blockers={blockers}
          pending={false}
          error={null}
        />
      }
    >
      <Field
        label={owes ? t('v3.liabilities.owed') : t('v3.holdings.amountFact.amount')}
        htmlFor="holding-edit-amount"
        hint={holding.token.symbol}
      >
        <AmountInput
          id="holding-edit-amount"
          value={amount}
          onValueChange={setAmount}
          // Not the display cap: see `BALANCE_EDIT_SCALE` (SC-567).
          decimalScale={BALANCE_EDIT_SCALE}
        />
      </Field>
      {showPot ? (
        <Field label={t('v3.holdings.labelFact.name')} htmlFor="holding-edit-pot">
          <Input
            id="holding-edit-pot"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            maxLength={HOLDING_LABEL_MAX_LENGTH}
            placeholder={t('v3.holdings.labelFact.placeholder')}
          />
        </Field>
      ) : null}
      {asksCause ? cause.section : null}
    </FormSheet>
  );
}
