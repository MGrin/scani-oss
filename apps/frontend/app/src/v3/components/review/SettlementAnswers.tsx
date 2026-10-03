import { balanceDecimals, Decimal, formatDate } from '@scani/shared';
import { userFacingMessage } from '@scani/ui/lib/user-facing-error';
import { Button } from '@scani/ui/ui/button';
import { ToastAction } from '@scani/ui/ui/toast';
import { useToast } from '@scani/ui/ui/use-toast';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import { useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { trpc } from '@/lib/trpc';
import { FormSheet } from '../form/FormSheet';

/**
 * One holding's answers that imported trades now explain (SC-1453).
 *
 * The owner answered a balance change on a broker's cash before its trades
 * were written there, so the same money is now booked twice. Nothing decides
 * that for them (SC-858): this sheet lists the answers and the owner retires
 * them, keeps them, or leaves. Retire takes the answers' rows out of the ledger
 * and the toast's Undo puts them back exactly.
 *
 * An answer that also recorded money arriving in another account, or leaving
 * the owner's control, asks a second time before Retire, because retiring it
 * changes that other holding too. The second question is drawn in the footer
 * rather than through `ConfirmAction`, which the UI standard keeps out of a
 * form sheet (rule 13).
 */
export function SettlementAnswersSheet({
  holdingId,
  onClose,
}: {
  holdingId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const utils = trpc.useUtils();
  const pending = trpc.settlementAnswers.listPending.useQuery();
  const retire = trpc.settlementAnswers.retire.useMutation();
  const keep = trpc.settlementAnswers.keep.useMutation();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const holding = pending.data?.find((group) => group.holdingId === holdingId);

  // Answered from another tab, or already retired: there is nothing to show.
  useEffect(() => {
    if (pending.isSuccess && !holding && !busy) onClose();
  }, [pending.isSuccess, holding, busy, onClose]);

  if (!holding) return null;

  const subject = holding.accountName
    ? t('v3.review.balances.subject', { account: holding.accountName, symbol: holding.tokenSymbol })
    : holding.tokenSymbol;
  const movesAnotherHolding = holding.answers.some((answer) => answer.movesAnotherHolding);
  const figure = (value: string) => (
    <Numeric
      value={value}
      format="plain"
      decimals={balanceDecimals(value, holding.tokenTypeCode)}
    />
  );

  const refresh = () =>
    Promise.all([
      utils.settlementAnswers.listPending.invalidate(),
      utils.review.listPending.invalidate(),
      utils.portfolio.invalidate(),
    ]);

  const retireAll = async (confirmOtherHolding: boolean) => {
    setBusy(true);
    setFailure(null);
    const retired: string[] = [];
    try {
      for (const answer of holding.answers) {
        const outcome = await retire.mutateAsync({
          observationId: answer.observationId,
          ...(confirmOtherHolding ? { confirmOtherHolding: true } : {}),
        });
        retired.push(outcome.id);
      }
    } catch (error) {
      setFailure(userFacingMessage(error) ?? t('v3.review.settled.failed'));
    }
    await refresh();
    setBusy(false);
    setConfirming(false);
    if (retired.length === 0) return;
    toast({
      title: t('v3.review.settled.toast.retired', { count: retired.length }),
      action: <UndoRetire retiredIds={retired} onWritten={refresh} />,
    });
    if (retired.length === holding.answers.length) onClose();
  };

  const keepAll = async () => {
    setBusy(true);
    setFailure(null);
    try {
      for (const answer of holding.answers)
        await keep.mutateAsync({ observationId: answer.observationId });
      await refresh();
      toast({ title: t('v3.review.settled.toast.kept') });
      onClose();
    } catch (error) {
      setFailure(userFacingMessage(error) ?? t('v3.review.settled.failed'));
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <FormSheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t('v3.review.settled.title', { subject })}
      description={t('v3.review.settled.description')}
      footer={
        <div className="flex flex-col gap-2">
          {failure ? (
            <p role="alert" className="text-caption text-destructive lg:text-end">
              {failure}
            </p>
          ) : null}
          {confirming ? (
            <div data-confirm-open="" className="flex flex-col gap-2">
              <p className="text-caption text-muted-foreground lg:text-end">
                {t('v3.review.settled.confirmOther')}
              </p>
              <div className="flex flex-col-reverse gap-2 lg:flex-row lg:justify-end">
                <Button variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>
                  {t('v3.form.cancel')}
                </Button>
                <Button variant="destructive" disabled={busy} onClick={() => retireAll(true)}>
                  {t('v3.review.settled.confirmRetire')}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col-reverse gap-2 lg:flex-row lg:justify-end">
              <Button variant="ghost" disabled={busy} onClick={onClose}>
                {t('v3.form.cancel')}
              </Button>
              <Button variant="outline" disabled={busy} onClick={keepAll}>
                {t('v3.review.settled.keep')}
              </Button>
              <Button
                variant="destructive"
                disabled={busy}
                onClick={() => (movesAnotherHolding ? setConfirming(true) : retireAll(false))}
              >
                {t('v3.review.settled.retire')}
              </Button>
            </div>
          )}
        </div>
      }
    >
      <ul className="flex flex-col divide-y divide-border">
        {holding.answers.map((answer) => {
          const explained = new Decimal(answer.amount).sub(answer.remainder).abs().toString();
          return (
            <li
              key={answer.observationId}
              className="flex items-start justify-between gap-3 py-3 first:pt-0"
            >
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-label">
                  {t('v3.review.balances.between', {
                    from: formatDate(answer.from),
                    to: formatDate(answer.to),
                  })}
                </span>
                <span className="text-caption text-muted-foreground">
                  {answer.explained === 'full' ? (
                    t('v3.review.settled.full')
                  ) : (
                    <Trans
                      i18nKey="v3.review.settled.partial"
                      components={{
                        explained: figure(explained),
                        amount: figure(new Decimal(answer.amount).abs().toString()),
                      }}
                    />
                  )}
                </span>
                {answer.movesAnotherHolding ? (
                  <span className="text-caption text-muted-foreground">
                    {t('v3.review.settled.movesOther')}
                  </span>
                ) : null}
              </span>
              <span className="shrink-0 whitespace-nowrap">
                <Numeric
                  value={answer.amount}
                  format="plain"
                  delta
                  decimals={balanceDecimals(answer.amount, holding.tokenTypeCode)}
                />
              </span>
            </li>
          );
        })}
      </ul>
    </FormSheet>
  );
}

/** "Undo" on the toast: every retired answer back, rows and all. */
function UndoRetire({
  retiredIds,
  onWritten,
}: {
  retiredIds: string[];
  onWritten: () => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const undo = trpc.settlementAnswers.undoRetire.useMutation();
  const [pending, setPending] = useState(false);
  return (
    <ToastAction
      altText={t('v3.review.settled.undo')}
      disabled={pending}
      onClick={async () => {
        setPending(true);
        try {
          for (const retiredId of retiredIds) await undo.mutateAsync({ retiredId });
          toast({ title: t('v3.review.settled.toast.undone') });
        } catch (error) {
          toast({
            title: t('v3.review.settled.toast.undoFailed'),
            description: userFacingMessage(error) ?? undefined,
            variant: 'destructive',
          });
        } finally {
          await onWritten();
          setPending(false);
        }
      }}
    >
      {t('v3.review.settled.undo')}
    </ToastAction>
  );
}
