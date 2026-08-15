import { formatRelative, type PendingTransferReview } from '@scani/shared';
import { Button } from '@scani/ui/ui/button';
import { Block } from '@scani/ui/v3/components/Block';
import { V3DataView } from '@scani/ui/v3/components/data-view/V3DataView';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import { rowName, type V3DataViewConfig } from '@scani/ui/v3/lib/data-view';
import { BLANK_CELL, exportDateTime, exportMoney } from '@scani/ui/v3/lib/export/cell';
import type { V3QueryState } from '@scani/ui/v3/lib/query-state';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { TRANSFER_REVIEW_PATH, V3_ROUTES } from '../../lib/routes';
import {
  candidateHint,
  comparePendingTransfers,
  exactMoment,
  occurredLabel,
  pendingLocation,
  pendingTransferMatches,
  UNREVIEWED_TRANSFER_BEHAVIOUR,
} from '../../lib/transfer-review';
import { TransferDecision } from './TransferDecision';

/**
 * Transfers out with no matching deposit (SC-150).
 *
 * Unlike `/review`, this list *is* the record's surface — the decision happens
 * in the peek, which is why the row peeks rather than navigating. The
 * comparison a reader has to make is between two rows in different accounts,
 * and a page would take away the queue they are working through; a sheet keeps
 * the remaining count on screen behind it, which is the only feedback that a
 * queue of eleven is becoming a queue of three.
 *
 * The value zone holds what realizing this row books as a gain — the number
 * that says why the question is worth answering, and the reason the surface is
 * not a chore list. `null` there means no price could be resolved that day; it
 * renders blank rather than as zero, because "we don't know" and "nothing" are
 * different claims and only one of them is true.
 */

interface TransferReviewListProps {
  items: PendingTransferReview[];
  query: V3QueryState;
}

export function TransferReviewList({ items, query }: TransferReviewListProps) {
  const navigate = useNavigate();

  const config: V3DataViewConfig<PendingTransferReview> = {
    pageKey: 'transfer-review',
    data: items,
    noun: 'transfers',
    nounSingular: 'transfer',
    searchPlaceholder: 'Search transfers',
    searchFn: pendingTransferMatches,
    filterDefs: [],
    sortDefs: [
      { key: 'occurred', label: 'When' },
      { key: 'amount', label: 'Value' },
      { key: 'token', label: 'Asset' },
    ],
    sortFn: comparePendingTransfers,
    defaultSort: { field: 'occurred', direction: 'desc' },
    renderRow: (item) => ({
      label: `${item.quantity} ${item.tokenSymbol}`,
      sublabel: `${pendingLocation(item)} · ${candidateHint(item)}`,
      value: item.marketValueInBase ? (
        <Numeric value={Number(item.marketValueInBase)} currency={item.baseCurrencyCode} />
      ) : null,
      delta: <span className="text-muted-foreground">{occurredLabel(item.occurredAt)}</span>,
      ariaLabel: rowName([
        `${item.quantity} ${item.tokenSymbol}`,
        pendingLocation(item),
        candidateHint(item),
        occurredLabel(item.occurredAt),
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
        key: 'matches',
        header: 'Why it is here',
        render: (item) => (
          <span className="truncate text-muted-foreground">{candidateHint(item)}</span>
        ),
      },
      {
        key: 'amount',
        // What answering "it left my portfolio" would realize — not what is
        // realized today, which since SC-150 is nothing.
        header: 'If it was a sale',
        numeric: true,
        sortable: true,
        width: 'w-40',
        render: (item) =>
          item.marketValueInBase ? (
            <Numeric value={Number(item.marketValueInBase)} currency={item.baseCurrencyCode} />
          ) : null,
        exportValue: (item) =>
          item.marketValueInBase
            ? exportMoney(Number(item.marketValueInBase), item.baseCurrencyCode)
            : BLANK_CELL,
        exportTotal: true,
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
    /**
     * What is at stake, above the rows.
     *
     * Here rather than on the page because it counts the **filtered** set: a
     * reader who has searched down to one token is owed the exposure of what
     * is on screen, not of the whole queue. It scrolls away, which is right —
     * it answers "what am I looking at" on arrival and then gets out of the
     * way of the work.
     */
    summary: (visible) => {
      if (visible.length === 0) return null;
      const exposure = visible.reduce((sum, item) => sum + Number(item.marketValueInBase ?? 0), 0);
      const unpriced = visible.filter((item) => !item.marketValueInBase).length;
      return (
        <Block className="flex gap-3 p-4">
          <AlertTriangle
            className="mt-0.5 size-4 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <div className="flex min-w-0 flex-col gap-1">
            <p className="text-caption text-muted-foreground">{UNREVIEWED_TRANSFER_BEHAVIOUR}</p>
            {exposure > 0 ? (
              <p className="text-caption">
                {/* Not "booked as gains" any more — since SC-150's second
                    half nothing here is booked at all. What the figure now
                    means is how much value is sitting on an unanswered
                    question, which is the reason to answer it. */}
                <span className="text-muted-foreground">Value awaiting an answer: </span>
                <Numeric value={exposure} currency={visible[0]?.baseCurrencyCode ?? ''} />
                {unpriced > 0 ? (
                  <span className="text-muted-foreground">
                    {` · ${unpriced} more with no price that day`}
                  </span>
                ) : null}
              </p>
            ) : null}
          </div>
        </Block>
      );
    },
    empty: {
      icon: CheckCircle2,
      title: 'Every transfer is accounted for',
      description:
        'Money moving between your own accounts is matched up automatically. Anything the matcher cannot settle on its own lands here for you to answer.',
      action: (
        <Button asChild variant="outline">
          <Link to={V3_ROUTES.review}>Back to review</Link>
        </Button>
      ),
    },
    peek: {
      basePath: TRANSFER_REVIEW_PATH,
      render: (item) => ({
        title: `${item.quantity} ${item.tokenSymbol}`,
        subtitle: `${item.kind === 'withdraw' ? 'Withdrawal' : 'Transfer out'} · ${pendingLocation(item)}`,
        value: item.marketValueInBase ? (
          <Numeric value={Number(item.marketValueInBase)} currency={item.baseCurrencyCode} />
        ) : undefined,
        delta: (
          <span className="text-muted-foreground">{formatRelative(new Date(item.occurredAt))}</span>
        ),
        /**
         * Three facts at most, and none of them repeats the header.
         *
         * The first phone capture carried `From` and `At market that day` as
         * well, and both were already on screen — `From` is the subtitle, and
         * the market value IS the figure. Between them they pushed the second
         * candidate and all three answers below the sheet's rest height, which
         * on a comparison task is the whole content: a reader at 390px saw one
         * of the two deposits they were being asked to choose between.
         *
         * `When` earns its line because the header says "3d ago" and the
         * judgement needs the actual time — 18 minutes apart is the fact that
         * settles a pairing. `To` and `Description` are only present when the
         * importer recorded them, and when they are they are usually the
         * answer on their own.
         */
        primary: [
          { label: 'When', value: exactMoment(item.occurredAt) },
          ...(item.counterparty ? [{ label: 'To', value: item.counterparty }] : []),
          ...(item.description ? [{ label: 'Description', value: item.description }] : []),
        ],
        content: <TransferDecision item={item} onResolved={() => navigate(TRANSFER_REVIEW_PATH)} />,
      }),
    },
  };

  return <V3DataView config={config} getId={(item) => item.transactionId} query={query} />;
}
