import type { AnsweredTransferReview } from '@scani/shared';
import { formatDate, formatRelative } from '@scani/shared';
import { Button } from '@scani/ui/ui/button';
import { useToast } from '@scani/ui/ui/use-toast';
import { ConfirmAction } from '@scani/ui/v3/components/ConfirmAction';
import { V3DataView } from '@scani/ui/v3/components/data-view/V3DataView';
import { rowName, type V3DataViewConfig } from '@scani/ui/v3/lib/data-view';
import { exportDateTime, exportText } from '@scani/ui/v3/lib/export/cell';
import type { V3QueryState } from '@scani/ui/v3/lib/query-state';
import { Inbox } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { trpc } from '@/lib/trpc';
import { TRANSFER_ANSWERED_PATH, TRANSFER_REVIEW_PATH } from '../../lib/routes';
import { answeredSummary, pendingLocation } from '../../lib/transfer-review';

/**
 * Transfers already answered, and the one action on them (SC-181).
 *
 * Its reason to exist is a number: 573 transfers were answered `left_control`
 * in a single bulk pass, before an answer could apply to part of a transaction.
 * Any of them that were partly a move between the reader's own accounts now
 * overstate the realized gain, and the withdrawal that prompted SC-181 is one
 * of them — so shipping the division with no route to an answered row would
 * leave the reported case unfixable.
 *
 * **The only action is Reopen.** Re-answering in place would need the
 * candidate search and the price lookup the pending list pays for per row,
 * against a list that is two orders of magnitude longer; reopening costs one
 * mutation and hands the row back to the queue, where the full surface already
 * lives. It is also the honest sequence — an answer is withdrawn, then a new
 * one is given, and the row's state is never two answers at once.
 *
 * Reopening is confirmed rather than immediate because it moves a number: an
 * outflow answered `left_control` carries a realized gain, and putting it back
 * in the queue takes that gain off the chart until the reader answers again.
 */

interface AnsweredTransferListProps {
  items: AnsweredTransferReview[];
  query: V3QueryState;
}

export function AnsweredTransferList({ items, query }: AnsweredTransferListProps) {
  const config: V3DataViewConfig<AnsweredTransferReview> = {
    pageKey: 'transfer-answered',
    data: items,
    noun: 'transfers',
    nounSingular: 'transfer',
    searchPlaceholder: 'Search answered transfers',
    searchFn: (item, term) =>
      [item.tokenSymbol, item.accountName, item.institutionName, item.counterparty]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(term.toLowerCase()),
    filterDefs: [],
    sortDefs: [
      { key: 'occurred', label: 'When' },
      { key: 'token', label: 'Asset' },
    ],
    sortFn: (a, b, field, direction) => {
      const mult = direction === 'asc' ? 1 : -1;
      if (field === 'token') return a.tokenSymbol.localeCompare(b.tokenSymbol) * mult;
      return (new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime()) * mult;
    },
    defaultSort: { field: 'occurred', direction: 'desc' },
    renderRow: (item) => ({
      label: `${item.quantity} ${item.tokenSymbol}`,
      sublabel: `${pendingLocation(item)} · ${answeredSummary(item)}`,
      // No figure: this list carries no price lookup, and a blank value zone
      // is the honest rendering of "we did not ask" — see `listAnswered`.
      value: null,
      delta: (
        <span className="text-muted-foreground">{formatRelative(new Date(item.occurredAt))}</span>
      ),
      ariaLabel: rowName([
        `${item.quantity} ${item.tokenSymbol}`,
        pendingLocation(item),
        answeredSummary(item),
      ]),
    }),
    columns: [
      {
        key: 'asset',
        header: 'Left',
        sortable: true,
        render: (item) => `${item.quantity} ${item.tokenSymbol}`,
      },
      { key: 'from', header: 'From', render: (item) => pendingLocation(item) },
      {
        key: 'answer',
        header: 'Your answer',
        render: (item) => <span className="truncate">{answeredSummary(item)}</span>,
        exportValue: (item) => exportText(answeredSummary(item)),
      },
      {
        key: 'occurred',
        header: 'When',
        sortable: true,
        width: 'w-40',
        render: (item) => (
          <span className="text-muted-foreground">{formatRelative(new Date(item.occurredAt))}</span>
        ),
        exportValue: (item) => exportDateTime(new Date(item.occurredAt)),
      },
    ],
    empty: {
      icon: Inbox,
      title: 'No transfers answered yet',
      description:
        'Answers you give in the transfer queue land here, so you can come back and change one.',
      action: (
        <Button asChild variant="outline">
          <Link to={TRANSFER_REVIEW_PATH}>Back to the queue</Link>
        </Button>
      ),
    },
    peek: {
      basePath: TRANSFER_ANSWERED_PATH,
      render: (item) => ({
        title: `${item.quantity} ${item.tokenSymbol}`,
        subtitle: `${item.kind === 'withdraw' ? 'Withdrawal' : 'Transfer out'} · ${pendingLocation(item)}`,
        delta: (
          <span className="text-muted-foreground">{formatRelative(new Date(item.occurredAt))}</span>
        ),
        primary: [
          { label: 'You said', value: answeredSummary(item) },
          ...(item.reviewedAt ? [{ label: 'Answered', value: formatDate(item.reviewedAt) }] : []),
          ...(item.counterparty ? [{ label: 'To', value: item.counterparty }] : []),
        ],
        content: <ReopenAction item={item} />,
      }),
    },
  };

  return <V3DataView config={config} getId={(item) => item.transactionId} query={query} />;
}

function ReopenAction({ item }: { item: AnsweredTransferReview }) {
  const { toast } = useToast();
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const reopen = trpc.transferReview.reopen.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.transferReview.listAnswered.invalidate(),
        utils.transferReview.listPending.invalidate(),
        utils.review.listPending.invalidate(),
      ]);
      setOpen(false);
      toast({ title: 'Back in the queue — answer it again there' });
      // Straight to the queue rather than back to a list this row has just
      // left. The reader reopened it in order to answer it differently, and
      // leaving them on a page where it no longer appears is a dead end
      // dressed as a success.
      navigate(TRANSFER_REVIEW_PATH);
    },
    onError: (error) => {
      setOpen(false);
      toast({
        title: 'That transfer could not be reopened',
        description: error.message,
        variant: 'destructive',
      });
    },
  });

  return (
    <ConfirmAction
      label="Change this answer"
      confirmLabel="Put it back in the queue"
      consequence={
        item.decision === 'left_control'
          ? 'The gain this booked comes off your realized total until you answer it again, and the transfer rejoins the queue.'
          : 'The transfer rejoins the queue, and nothing about it is settled until you answer it again.'
      }
      isPending={reopen.isPending}
      open={open}
      onOpenChange={setOpen}
      onConfirm={() => reopen.mutate({ transactionId: item.transactionId })}
    />
  );
}
