import { userFacingMessage } from '@scani/ui/lib/user-facing-error';
import { useToast } from '@scani/ui/ui/use-toast';
import { ConfirmAction } from '@scani/ui/v3/components/ConfirmAction';
import { V3DataView } from '@scani/ui/v3/components/data-view/V3DataView';
import type { V3DataViewConfig } from '@scani/ui/v3/lib/data-view';
import type { V3QueryState } from '@scani/ui/v3/lib/query-state';
import { Inbox } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { trpc } from '@/lib/trpc';
import { formatRelative } from '../../lib/relative-time';
import { BALANCE_GAP_ANSWERED_PATH, BALANCE_GAP_REVIEW_PATH } from '../../lib/routes';

export interface AnsweredBalanceGap {
  observationId: string;
  answer: string | null;
  reviewedAt: string | null;
  tokenSymbol: string;
  accountName: string;
}

/**
 * Balance changes already explained, each with its undo (SC-1433).
 *
 * The balance queue's second view, as `AnsweredTransferList` is the transfer
 * queue's. It was a hand-made `<details>` of text lines and inline buttons
 * under the queue until SC-1433 — the one list of answers in the app with no
 * search, no peek and no empty state.
 */
export function AnsweredBalanceGapList({
  items,
  query,
}: {
  items: AnsweredBalanceGap[];
  query: V3QueryState;
}) {
  const { t } = useTranslation();
  const subject = (row: AnsweredBalanceGap) =>
    t('v3.review.balances.subject', { account: row.accountName, symbol: row.tokenSymbol });
  const answerLabel = (row: AnsweredBalanceGap) =>
    row.answer ? t(`v3.review.balances.option.${row.answer}`) : '';
  const when = (row: AnsweredBalanceGap) =>
    row.reviewedAt ? formatRelative(t, new Date(row.reviewedAt)) : '';

  const config: V3DataViewConfig<AnsweredBalanceGap> = {
    pageKey: 'balance-gaps-answered',
    data: items,
    nounKey: 'ui.dataView.noun.balanceChanges',
    searchPlaceholderKey: 'ui.dataView.balanceGaps.config.search',
    searchFn: (row, term) =>
      `${row.accountName} ${row.tokenSymbol}`
        .toLocaleLowerCase()
        .includes(term.toLocaleLowerCase()),
    renderRow: (row) => ({
      label: subject(row),
      sublabel: answerLabel(row),
      value: <span className="text-muted-foreground">{when(row)}</span>,
      ariaLabel: `${subject(row)}, ${answerLabel(row)}`,
    }),
    columns: [
      {
        key: 'subject',
        headerKey: 'ui.dataView.balanceGaps.col.change',
        render: (row) => <span className="truncate text-label">{subject(row)}</span>,
      },
      {
        key: 'answer',
        headerKey: 'ui.dataView.balanceGaps.col.answer',
        render: answerLabel,
      },
      {
        key: 'reviewed',
        headerKey: 'ui.dataView.balanceGaps.col.answered',
        render: (row) => <span className="text-muted-foreground">{when(row)}</span>,
      },
    ],
    empty: {
      icon: Inbox,
      titleKey: 'ui.dataView.answeredBalanceGaps.empty.nothingAnsweredYet',
      descriptionKey: 'ui.dataView.answeredBalanceGaps.empty.answersLandHere',
      action: null,
    },
    peek: {
      basePath: BALANCE_GAP_ANSWERED_PATH,
      render: (row) => ({
        title: subject(row),
        subtitle: answerLabel(row),
        primary: [{ label: t('v3.review.balances.answeredOn'), value: when(row) }],
        actions: <UndoAction row={row} />,
      }),
    },
  };

  return <V3DataView config={config} getId={(row) => row.observationId} query={query} />;
}

function UndoAction({ row }: { row: AnsweredBalanceGap }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  const undo = trpc.balanceGaps.undo.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.balanceGaps.invalidate(),
        utils.transferReview.invalidate(),
        utils.portfolio.invalidate(),
        utils.review.invalidate(),
      ]);
      setOpen(false);
      // Back to the queue, where the change is waiting to be answered again,
      // as reopening a transfer does.
      navigate(BALANCE_GAP_REVIEW_PATH);
    },
    onError: (error) =>
      toast({
        variant: 'destructive',
        title: t('v3.review.balances.undoFailed'),
        description: userFacingMessage(error) ?? t('v3.review.balances.answerFailedBody'),
      }),
  });

  return (
    <ConfirmAction
      label={t('v3.review.balances.undo')}
      confirmLabel={t('v3.review.balances.undoCommit')}
      consequence={t('v3.review.balances.undoConsequence')}
      isPending={undo.isPending}
      open={open}
      onOpenChange={setOpen}
      onConfirm={() => undo.mutate({ observationId: row.observationId })}
    />
  );
}
