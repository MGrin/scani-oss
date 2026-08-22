import type { BalanceGapAnswer as Answer, BalanceGap } from '@scani/shared';
import { BALANCE_GAP_ANSWERS } from '@scani/shared';
import { userFacingMessage } from '@scani/ui/lib/user-facing-error';
import { Button } from '@scani/ui/ui/button';
import { Label } from '@scani/ui/ui/label';
import { Segmented, SegmentedItem } from '@scani/ui/ui/segmented';
import { useToast } from '@scani/ui/ui/use-toast';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '@/lib/trpc';
import { DateField, localDateFromIso } from '../form/DateField';

/**
 * "What was this?" — the same question `HoldingEditCauseDialog` asks about a
 * balance the owner typed, asked about one a sync observed (SC-501).
 *
 * The three causes are `MANUAL_EDIT_CAUSES` and they reach the same writer, so
 * the wording, the ordering and the per-cause explanation are shared with that
 * dialog rather than restated. What is different here is the fourth answer and
 * the default date.
 *
 * **Nothing is pre-selected.** A queue that empties itself by offering the
 * likely answer under the reader's finger is a queue that produces confident
 * wrong flows, and this feature exists because a confident wrong flow is
 * exactly what nobody could see. The reader picks.
 *
 * **A date is asked for only when it can beat what we already hold.** On a
 * short interval the two observations date the movement to the hour, and a
 * date field cannot: it collects a DAY, and a day becomes an instant at local
 * midnight. Measured on production 2026-08-22 with the owner in UTC+8, an
 * honest date-only answer landed fourteen hours before the hour it described.
 * So `datePrompted` is false there and the server stamps the closing
 * observation, which is more precise than anything this control could return.
 *
 * When it IS asked for — a seventy-one-day gap, a forty-day one — it defaults
 * to the end of the interval and the server clamps it into the window. Today
 * would be the one date the money demonstrably did not move, because the
 * closing observation already shows it had moved by then.
 */

interface BalanceGapAnswerProps {
  gap: BalanceGap;
  onAnswered: () => void;
}

/** `YYYY-MM-DD` in the reader's own zone, which is the zone the field edits. */
function isoDate(at: Date): string {
  const month = String(at.getMonth() + 1).padStart(2, '0');
  const day = String(at.getDate()).padStart(2, '0');
  return `${at.getFullYear()}-${month}-${day}`;
}

export function BalanceGapAnswer({ gap, onAnswered }: BalanceGapAnswerProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [date, setDate] = useState(() => isoDate(new Date(gap.to)));

  const mutation = trpc.balanceGaps.answer.useMutation({
    onSuccess: onAnswered,
    onError: (error) =>
      toast({
        variant: 'destructive',
        title: t('v3.review.balances.answerFailed'),
        // `userFacingMessage` passes a deliberately-written server message
        // through and returns null for anything else, so an internal string
        // cannot reach this toast (SC-311, SC-551). The fallback is ours.
        description: userFacingMessage(error) ?? t('v3.review.balances.answerFailedBody'),
      }),
  });

  const submit = () => {
    if (!answer) return;
    // `localDateFromIso` rather than `new Date(value)`: the second is UTC
    // midnight, which every zone west of Greenwich renders as the previous
    // day — and a flow's date is the whole point of this answer.
    const occurredAt = answer === 'flow' ? localDateFromIso(date) : null;
    if (answer === 'flow' && !occurredAt) return;
    mutation.mutate({
      observationId: gap.observationId,
      answer,
      ...(occurredAt ? { occurredAt } : {}),
    });
  };

  return (
    <div className="flex flex-col gap-3">
      <Segmented
        value={answer ?? ''}
        onValueChange={(next) => setAnswer(next as Answer)}
        aria-label={t('v3.review.balances.answerLabel')}
      >
        {BALANCE_GAP_ANSWERS.map((option) => (
          <SegmentedItem key={option} value={option}>
            {t(`v3.review.balances.option.${option}`)}
          </SegmentedItem>
        ))}
      </Segmented>

      {answer ? (
        <p className="text-label text-muted-foreground">
          {t(`v3.review.balances.explain.${answer}`)}
        </p>
      ) : null}

      {answer === 'flow' && gap.datePrompted ? (
        <div className="flex flex-col gap-2">
          <Label htmlFor={`balance-gap-date-${gap.observationId}`}>
            {t('v3.review.balances.dateLabel')}
          </Label>
          <DateField id={`balance-gap-date-${gap.observationId}`} value={date} onChange={setDate} />
        </div>
      ) : null}

      <div>
        <Button disabled={!answer || mutation.isPending} onClick={submit}>
          {t('v3.review.balances.record')}
        </Button>
      </div>
    </div>
  );
}
