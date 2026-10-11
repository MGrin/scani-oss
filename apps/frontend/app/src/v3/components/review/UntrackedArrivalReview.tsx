import {
  formatDate,
  formatNumber,
  quantityDecimals,
  type UntrackedArrivalKey,
} from '@scani/shared';
import { userFacingMessage } from '@scani/ui/lib/user-facing-error';
import { Button } from '@scani/ui/ui/button';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '@/lib/trpc';
import { FormSheet } from '../form/FormSheet';

const quantity = (value: string) => formatNumber(value, { decimals: quantityDecimals(value) });

/**
 * "Was this the transfer to <account>?" (SC-1696). The owner answered this
 * outflow `untracked`, and the same amount has since arrived in an account
 * Scani tracks. Yes links the two; no keeps the answer and this arrival is not
 * offered for it again. Opening the sheet writes nothing.
 */
export function UntrackedArrivalSheet({
  question: key,
  onClose,
}: {
  question: UntrackedArrivalKey;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const due = trpc.untrackedArrivalReview.listDue.useQuery();
  const confirm = trpc.untrackedArrivalReview.confirm.useMutation();
  const decline = trpc.untrackedArrivalReview.decline.useMutation();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const question = due.data?.find(
    (item) => item.outflowId === key.outflowId && item.inflowId === key.inflowId
  );

  // Answered from another tab, or no longer unanimous: there is nothing to ask.
  useEffect(() => {
    if (due.isSuccess && !question && !busy) onClose();
  }, [due.isSuccess, question, busy, onClose]);

  if (!question) return null;

  const answer = async (yes: boolean) => {
    setBusy(true);
    setFailure(null);
    try {
      await (yes ? confirm : decline).mutateAsync(key);
    } catch (error) {
      setFailure(userFacingMessage(error) ?? t('v3.review.untrackedArrival.failed'));
      setBusy(false);
      return;
    }
    await Promise.all([
      utils.untrackedArrivalReview.invalidate(),
      utils.review.listPending.invalidate(),
      utils.transferReview.invalidate(),
      ...(yes ? [utils.holdings.invalidate(), utils.portfolio.invalidate()] : []),
    ]);
    setBusy(false);
    onClose();
  };

  return (
    <FormSheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t('v3.review.untrackedArrival.title', {
        destination: question.destinationAccountName,
      })}
      description={t('v3.review.untrackedArrival.description', {
        amount: `${quantity(question.quantity)} ${question.tokenSymbol}`,
        source: question.sourceAccountName,
        date: formatDate(question.sentAt),
        arrived: `${quantity(question.arrivedQuantity)} ${question.tokenSymbol}`,
        destination: question.destinationAccountName,
        arrivedDate: formatDate(question.arrivedAt),
      })}
      footer={
        <div className="flex flex-col gap-2">
          {failure ? (
            <p role="alert" className="text-caption text-destructive lg:text-end">
              {failure}
            </p>
          ) : null}
          <div className="flex flex-col-reverse gap-2 lg:flex-row lg:justify-end">
            <Button variant="ghost" disabled={busy} onClick={() => answer(false)}>
              {t('v3.review.untrackedArrival.decline')}
            </Button>
            <Button disabled={busy} onClick={() => answer(true)}>
              {t('v3.review.untrackedArrival.confirm')}
            </Button>
          </div>
        </div>
      }
    >
      <p className="text-caption text-muted-foreground">
        {t('v3.review.untrackedArrival.keepNote')}
      </p>
    </FormSheet>
  );
}
