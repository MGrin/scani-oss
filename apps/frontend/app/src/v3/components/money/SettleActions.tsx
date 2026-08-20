import { Button } from '@scani/ui/ui/button';
import { showError, showSuccess } from '@scani/ui/ui/use-toast';
import { AmountInput } from '@scani/ui/v3/components/AmountInput';
import { Check, Loader2, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '@/lib/trpc';

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
 * The amount editor stays inline rather than becoming a second overlay — a
 * dialog stacked on a sheet is two dismiss gestures deep, and the amount is
 * usually already known and only needs confirming.
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
  const [editing, setEditing] = useState(false);
  const [amount, setAmount] = useState(expectedAmount ?? '');
  const utils = trpc.useUtils();

  const settleLabel =
    direction === 'inflow' ? t('v3.money.settle.markReceived') : t('v3.money.settle.markPaid');
  const settledLabel =
    direction === 'inflow' ? t('v3.money.settle.markedReceived') : t('v3.money.settle.markedPaid');

  const settleMutation = trpc.payments.settleOccurrence.useMutation({
    onSuccess: (_, variables) => {
      setEditing(false);
      showSuccess(variables.status === 'skipped' ? t('v3.money.settle.skipped') : settledLabel);
      void utils.payments.invalidate();
      onSettled?.();
    },
    onError: (error) => showError(error, t('v3.money.pending.updatingOccurrence')),
  });

  if (editing) {
    return (
      <div className="flex w-full flex-wrap items-center gap-2">
        <AmountInput
          value={amount}
          onValueChange={setAmount}
          // 16px, like every other input in v3: iOS zooms the page on focusing
          // anything smaller, and the zoom reads as "the app jumped".
          className="w-32 text-body"
          aria-label={t('v3.money.settle.amountSettled')}
          decimalScale={2}
          disabled={settleMutation.isPending}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setEditing(false);
          }}
        />
        <Button
          disabled={settleMutation.isPending || amount.trim().length === 0}
          onClick={() =>
            settleMutation.mutate({ occurrenceId, status: 'matched', actualAmount: amount })
          }
        >
          {settleMutation.isPending ? (
            <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Check className="mr-1.5 h-4 w-4" aria-hidden="true" />
          )}
          {t('v3.money.settle.confirm')}
        </Button>
        <Button
          variant="ghost"
          aria-label={t('v3.money.settle.cancel')}
          disabled={settleMutation.isPending}
          onClick={() => setEditing(false)}
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
    );
  }

  return (
    <>
      <Button
        onClick={() => {
          setAmount(expectedAmount ?? '');
          setEditing(true);
        }}
      >
        <Check className="mr-1.5 h-4 w-4" aria-hidden="true" />
        {settleLabel}
      </Button>
      <Button
        variant="outline"
        disabled={settleMutation.isPending}
        onClick={() => settleMutation.mutate({ occurrenceId, status: 'skipped' })}
      >
        {t('v3.money.settle.skip')}
      </Button>
    </>
  );
}
