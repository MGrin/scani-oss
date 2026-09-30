import { Button } from '@scani/ui/ui/button';
import { showError, showSuccess } from '@scani/ui/ui/use-toast';
import { AmountInput } from '@scani/ui/v3/components/AmountInput';
import { describeQueryError } from '@scani/ui/v3/lib/errors';
import { Check } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '@/lib/trpc';
import { Field } from '../form/Field';
import { FormActions, FormSheet } from '../form/FormSheet';

/**
 * Settling an occurrence — the one thing the Money tab exists to let you do.
 *
 * Detection was dropped, so marking an occurrence paid or skipping it is how it
 * resolves, and v2 put that pair inline on every feed row. Here it lives in the
 * peek sheet's `actions` slot instead: a `<DataRow>` is three zones and none of
 * them is a button strip, and a row carrying two buttons plus an amount editor
 * is what a 393px screen cannot hold. The row opens the record; the record
 * carries what you can do to it.
 *
 * The amount is confirmed in a `FormSheet` (UI standard rule 13, SC-1433),
 * pre-filled with the expected amount, which is usually already right. It was
 * an inline amount box with an icon-only cancel in the peek's action row; a
 * sheet over the peek now sits beside it on desktop (rule 14), which was the
 * cost that kept it inline.
 */

interface SettleActionsProps {
  occurrenceId: string;
  /** Pre-fills the amount editor — the occurrence's own `expectedAmount`. */
  expectedAmount: string | null;
  /** Money arriving is received, not paid. */
  direction: 'inflow' | 'outflow';
  /** Fires once the occurrence leaves the feed, so the sheet over it can close. */
  onSettled?: () => void;
}

export function SettleActions({
  occurrenceId,
  expectedAmount,
  direction,
  onSettled,
}: SettleActionsProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const utils = trpc.useUtils();

  const settleLabel =
    direction === 'inflow' ? t('v3.money.settle.markReceived') : t('v3.money.settle.markPaid');

  const skip = trpc.payments.settleOccurrence.useMutation({
    onSuccess: () => {
      showSuccess(t('v3.money.settle.skipped'));
      void utils.payments.invalidate();
      onSettled?.();
    },
    onError: (error) => showError(error, t('v3.money.pending.updatingOccurrence')),
  });

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Check className="me-1.5 h-4 w-4" aria-hidden="true" />
        {settleLabel}
      </Button>
      <Button
        variant="outline"
        disabled={skip.isPending}
        onClick={() => skip.mutate({ occurrenceId, status: 'skipped' })}
      >
        {t('v3.money.settle.skip')}
      </Button>
      {/* Mounted only while open, so each opening seeds from the expected amount. */}
      {open ? (
        <SettleSheet
          occurrenceId={occurrenceId}
          expectedAmount={expectedAmount}
          direction={direction}
          onOpenChange={setOpen}
          onSettled={onSettled}
        />
      ) : null}
    </>
  );
}

function SettleSheet({
  occurrenceId,
  expectedAmount,
  direction,
  onOpenChange,
  onSettled,
}: SettleActionsProps & { onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const [amount, setAmount] = useState(expectedAmount ?? '');
  const [failure, setFailure] = useState<string | null>(null);
  const inflow = direction === 'inflow';

  const settle = trpc.payments.settleOccurrence.useMutation({
    onSuccess: () => {
      showSuccess(inflow ? t('v3.money.settle.markedReceived') : t('v3.money.settle.markedPaid'));
      void utils.payments.invalidate();
      onOpenChange(false);
      onSettled?.();
    },
    onError: (error) => {
      const copy = describeQueryError(error, t('v3.money.thisPayment'), 'save');
      setFailure(`${copy.title}. ${copy.detail}`);
    },
  });

  return (
    <FormSheet
      open
      onOpenChange={onOpenChange}
      title={inflow ? t('v3.money.settle.markReceived') : t('v3.money.settle.markPaid')}
      description={
        inflow ? t('v3.money.settle.descriptionReceived') : t('v3.money.settle.descriptionPaid')
      }
      footer={
        <FormActions
          submitLabel={inflow ? t('v3.money.settle.markReceived') : t('v3.money.settle.markPaid')}
          pendingLabel={t('v3.form.saving')}
          onSubmit={() =>
            settle.mutate({ occurrenceId, status: 'matched', actualAmount: amount.trim() })
          }
          onCancel={() => onOpenChange(false)}
          blockers={amount.trim() === '' ? [t('v3.money.settle.blockerAmount')] : []}
          pending={settle.isPending}
          error={failure}
        />
      }
    >
      <Field label={t('v3.money.settle.amountSettled')} htmlFor={`settle-amount-${occurrenceId}`}>
        <AmountInput
          id={`settle-amount-${occurrenceId}`}
          value={amount}
          onValueChange={setAmount}
          decimalScale={2}
          disabled={settle.isPending}
        />
      </Field>
    </FormSheet>
  );
}
