import {
  Decimal,
  formatDate,
  formatNumber,
  quantityDecimals,
  type TransitReviewKey,
} from '@scani/shared';
import { userFacingMessage } from '@scani/ui/lib/user-facing-error';
import { Button } from '@scani/ui/ui/button';
import { ChoiceRow } from '@scani/ui/v3/components/ChoiceRow';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '@/lib/trpc';
import { FormSheet } from '../form/FormSheet';

type Choice =
  | { kind: 'arrived'; id: string }
  | { kind: 'cameBack'; id: string }
  | { kind: 'lost'; decision: 'fee' | 'left_control' }
  | { kind: 'waiting' };

const sameChoice = (a: Choice | null, b: Choice): boolean =>
  a !== null && JSON.stringify(a) === JSON.stringify(b);

const quantity = (value: string) => formatNumber(value, { decimals: quantityDecimals(value) });

/**
 * The day-7 question about a transfer still in transit (SC-1675, rulings
 * #23848), asked about the part that went to one destination (SC-1684). The
 * money has stayed counted while it travelled, and it stays counted until
 * this is answered.
 *
 * Four answers, each its own procedure. An arrival or a refund can only be one
 * the server offered: an arrival on the destination up to 10% under what was
 * sent, a refund of exactly that amount to the source. A shortfall is said
 * aloud as a fee on the row itself, before anything is booked, because that is
 * the part a person would not expect. "Still waiting" writes no money and asks
 * again in 7 days.
 */
export function TransitReviewSheet({
  transit,
  onClose,
}: {
  transit: TransitReviewKey;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const due = trpc.transitReview.listDue.useQuery();
  const offered = trpc.transitReview.candidates.useQuery(transit);
  const arrived = trpc.transitReview.arrived.useMutation();
  const cameBack = trpc.transitReview.cameBack.useMutation();
  const lost = trpc.transitReview.lost.useMutation();
  const stillWaiting = trpc.transitReview.stillWaiting.useMutation();
  const [choice, setChoice] = useState<Choice | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const question = due.data?.find(
    (item) =>
      item.outflowId === transit.outflowId &&
      item.destinationHoldingId === transit.destinationHoldingId
  );

  // Answered from another tab, or arrived since: there is nothing to ask.
  useEffect(() => {
    if (due.isSuccess && !question && !busy) onClose();
  }, [due.isSuccess, question, busy, onClose]);

  if (!question) return null;

  const symbol = question.tokenSymbol;
  const arrivals = offered.data?.arrivals ?? [];
  const refunds = offered.data?.refunds ?? [];

  const save = async () => {
    if (!choice) return;
    setBusy(true);
    setFailure(null);
    try {
      if (choice.kind === 'arrived') {
        await arrived.mutateAsync({ ...transit, inflowId: choice.id });
      } else if (choice.kind === 'cameBack') {
        await cameBack.mutateAsync({ ...transit, refundId: choice.id });
      } else if (choice.kind === 'lost') {
        await lost.mutateAsync({ ...transit, decision: choice.decision });
      } else {
        await stillWaiting.mutateAsync(transit);
      }
    } catch (error) {
      setFailure(userFacingMessage(error) ?? t('v3.review.transit.failed'));
      setBusy(false);
      return;
    }
    await Promise.all([
      utils.transitReview.invalidate(),
      utils.review.listPending.invalidate(),
      utils.transferReview.invalidate(),
      utils.holdings.invalidate(),
      utils.portfolio.invalidate(),
    ]);
    setBusy(false);
    onClose();
  };

  const option = (id: string, next: Choice, label: string, detail?: string | null) => (
    <li key={id}>
      <ChoiceRow
        id={id}
        name="transit-answer"
        checked={sameChoice(choice, next)}
        onSelect={() => setChoice(next)}
      >
        <span className="text-body">{label}</span>
        {detail ? <span className="text-caption text-muted-foreground">{detail}</span> : null}
      </ChoiceRow>
    </li>
  );

  return (
    <FormSheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t('v3.review.transit.title')}
      description={t('v3.review.transit.description', {
        amount: `${quantity(question.quantity)} ${symbol}`,
        source: question.sourceAccountName,
        destination: question.destinationAccountName,
        date: formatDate(question.sentAt),
      })}
      footer={
        <div className="flex flex-col gap-2">
          {failure ? (
            <p role="alert" className="text-caption text-destructive lg:text-end">
              {failure}
            </p>
          ) : null}
          <div className="flex flex-col-reverse gap-2 lg:flex-row lg:justify-end">
            <Button variant="ghost" disabled={busy} onClick={onClose}>
              {t('v3.form.cancel')}
            </Button>
            <Button disabled={busy || choice === null} onClick={save}>
              {t('v3.review.transit.save')}
            </Button>
          </div>
        </div>
      }
    >
      <ul className="flex flex-col gap-2">
        {arrivals.length === 0 && !offered.isLoading ? (
          <li className="text-caption text-muted-foreground">
            {t('v3.review.transit.noArrival', { destination: question.destinationAccountName })}
          </li>
        ) : null}
        {arrivals.map((row) => {
          const short = new Decimal(question.quantity).minus(row.quantity);
          return option(
            `transit-arrival-${row.id}`,
            { kind: 'arrived', id: row.id },
            t('v3.review.transit.arrived', {
              amount: `${quantity(row.quantity)} ${symbol}`,
              destination: question.destinationAccountName,
              date: formatDate(row.occurredAt),
            }),
            short.gt(0)
              ? t('v3.review.transit.shortfall', {
                  amount: `${quantity(short.toString())} ${symbol}`,
                })
              : null
          );
        })}
        {refunds.map((row) =>
          option(
            `transit-refund-${row.id}`,
            { kind: 'cameBack', id: row.id },
            t('v3.review.transit.cameBack', {
              source: question.sourceAccountName,
              date: formatDate(row.occurredAt),
            })
          )
        )}
        {option(
          'transit-lost-fee',
          { kind: 'lost', decision: 'fee' },
          t('v3.review.transit.lostFee'),
          t('v3.review.transit.lostFeeDetail')
        )}
        {option(
          'transit-lost-left_control',
          { kind: 'lost', decision: 'left_control' },
          t('v3.review.transit.leftControl'),
          t('v3.review.transit.leftControlDetail')
        )}
        {option(
          'transit-waiting',
          { kind: 'waiting' },
          t('v3.review.transit.waiting'),
          t('v3.review.transit.waitingDetail')
        )}
      </ul>
    </FormSheet>
  );
}
