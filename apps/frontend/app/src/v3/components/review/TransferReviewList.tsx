import type { PendingTransferReview } from '@scani/shared';
import { Button } from '@scani/ui/ui/button';
import { Block } from '@scani/ui/v3/components/Block';
import { V3DataView } from '@scani/ui/v3/components/data-view/V3DataView';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import { rowName, type V3DataViewConfig } from '@scani/ui/v3/lib/data-view';
import { BLANK_CELL, exportDateTime, exportMoney } from '@scani/ui/v3/lib/export/cell';
import type { V3QueryState } from '@scani/ui/v3/lib/query-state';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Trans, useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { trpc } from '@/lib/trpc';
import { formatRelative } from '../../lib/relative-time';
import { TRANSFER_REVIEW_PATH, V3_ROUTES } from '../../lib/routes';
import {
  candidateHint,
  comparePendingTransfers,
  exactMoment,
  occurredLabel,
  pendingLocation,
  pendingTransferMatches,
  UNREVIEWED_TRANSFER_BEHAVIOUR_KEY,
} from '../../lib/transfer-review';
import { ExternalRef } from './ExternalRef';
import { TransferBulkAction } from './TransferBulkAction';
import { TransferDecision } from './TransferDecision';
import { TransferRuleAction } from './TransferRuleAction';

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
  const { t } = useTranslation();
  const navigate = useNavigate();
  const utils = trpc.useUtils();

  // The same three reads `TransferDecision` invalidates, and for the same
  // reason: a badge that still says 74 over a queue of nine is the
  // disagreement `useReviewFeed` exists to prevent.
  const invalidate = async () => {
    await Promise.all([
      utils.transferReview.listPending.invalidate(),
      utils.transferReview.listAnswered.invalidate(),
      utils.review.listPending.invalidate(),
    ]);
  };

  const config: V3DataViewConfig<PendingTransferReview> = {
    pageKey: 'transfer-review',
    data: items,
    nounKey: 'ui.dataView.noun.transfers',
    searchPlaceholderKey: 'ui.dataView.transferReview.config.searchTransfers',
    searchFn: pendingTransferMatches,
    filterDefs: [],
    sortDefs: [
      { key: 'occurred', labelKey: 'ui.dataView.transferReview.sort.when' },
      { key: 'amount', labelKey: 'ui.dataView.transferReview.sort.value' },
      { key: 'token', labelKey: 'ui.dataView.transferReview.sort.asset' },
    ],
    sortFn: comparePendingTransfers,
    defaultSort: { field: 'occurred', direction: 'desc' },
    renderRow: (item) => ({
      label: `${item.quantity} ${item.tokenSymbol}`,
      sublabel: `${pendingLocation(item)} · ${candidateHint(t, item)}`,
      value: item.marketValueInBase ? (
        <Numeric value={Number(item.marketValueInBase)} currency={item.baseCurrencyCode} />
      ) : null,
      delta: <span className="text-muted-foreground">{occurredLabel(t, item.occurredAt)}</span>,
      ariaLabel: rowName([
        `${item.quantity} ${item.tokenSymbol}`,
        pendingLocation(item),
        candidateHint(t, item),
        occurredLabel(t, item.occurredAt),
      ]),
    }),
    columns: [
      {
        key: 'asset',
        headerKey: 'ui.dataView.transferReview.col.left',
        sortable: true,
        render: (item) => `${item.quantity} ${item.tokenSymbol}`,
      },
      {
        key: 'from',
        headerKey: 'ui.dataView.transferReview.col.from',
        render: (item) => pendingLocation(item),
      },
      {
        key: 'matches',
        headerKey: 'ui.dataView.transferReview.col.whyItIsHere',
        render: (item) => (
          <span className="truncate text-muted-foreground">{candidateHint(t, item)}</span>
        ),
      },
      {
        key: 'amount',
        // What answering "it left my portfolio" would realize — not what is
        // realized today, which since SC-150 is nothing.
        headerKey: 'ui.dataView.transferReview.col.ifItWasASale',
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
        headerKey: 'ui.dataView.transferReview.col.when',
        sortable: true,
        width: 'w-40',
        render: (item) => (
          <span className="text-muted-foreground">
            {formatRelative(t, new Date(item.occurredAt))}
          </span>
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
            <p className="text-caption text-muted-foreground">
              {t(UNREVIEWED_TRANSFER_BEHAVIOUR_KEY)}
            </p>
            {exposure > 0 ? (
              <p className="text-caption">
                {/* Not "booked as gains" any more — since SC-150's second
                    half nothing here is booked at all. What the figure now
                    means is how much value is sitting on an unanswered
                    question, which is the reason to answer it. */}
                {/* One key per sentence, the figure as a slot (SC-235). The
                    label, the amount and the unpriced clause were three
                    siblings, so the only order a translator could produce was
                    this one. */}
                <Trans
                  i18nKey={
                    unpriced > 0
                      ? 'v3.review.list.valueAwaitingUnpriced'
                      : 'v3.review.list.valueAwaiting'
                  }
                  count={unpriced}
                  components={{
                    label: <span className="text-muted-foreground" />,
                    value: (
                      <Numeric value={exposure} currency={visible[0]?.baseCurrencyCode ?? ''} />
                    ),
                  }}
                />
              </p>
            ) : null}
          </div>
        </Block>
      );
    },
    empty: {
      icon: CheckCircle2,
      titleKey: 'ui.dataView.transferReview.empty.everyTransferIsAccountedFor',
      descriptionKey: 'ui.dataView.transferReview.empty.moneyMovingBetweenYourOwnAccounts',
      action: (
        <Button asChild variant="outline">
          <Link to={V3_ROUTES.review}>{t('v3.review.list.backToReview')}</Link>
        </Button>
      ),
    },
    /*
      Answer many at once (SC-382) — mgrin's own request, and the shape 65 of
      production's 74 pending rows are in: Solana outflows to no recorded
      destination, indistinguishable from one another and answered one tap at
      a time. Two answers, not four; see `TransferBulkAction`.
    */
    renderBulkActions: (selectedIds, clearSelection, deselect) => (
      <TransferBulkAction
        selectedIds={selectedIds}
        clearSelection={clearSelection}
        deselect={deselect}
        onWritten={invalidate}
      />
    ),
    peek: {
      basePath: TRANSFER_REVIEW_PATH,
      render: (item) => ({
        title: `${item.quantity} ${item.tokenSymbol}`,
        subtitle: `${t(item.kind === 'withdraw' ? 'v3.review.kind.withdrawal' : 'v3.review.kind.transferOut')} · ${pendingLocation(item)}`,
        value: item.marketValueInBase ? (
          <Numeric value={Number(item.marketValueInBase)} currency={item.baseCurrencyCode} />
        ) : undefined,
        delta: (
          <span className="text-muted-foreground">
            {formatRelative(t, new Date(item.occurredAt))}
          </span>
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
          { label: t('v3.review.list.field.when'), value: exactMoment(item.occurredAt) },
          ...(item.counterparty
            ? [
                {
                  label: t('v3.review.list.field.to'),
                  // Linked when we know the chain's explorer, plain text
                  // otherwise. An address is the fact that identifies a
                  // transfer nobody remembers making (SC-346), and it is
                  // useless as text you have to copy out by hand.
                  // The address, and — when we can prove it — whose it is
                  // (SC-350). `OwnWalletNotice` carries the argument above the
                  // answers; this is the same fact where the address itself is,
                  // so a reader checking the destination does not have to hold
                  // the callout in their head to read the hex.
                  value: (
                    <span className="flex flex-col gap-0.5">
                      {item.explorerAddressUrl ? (
                        <ExternalRef href={item.explorerAddressUrl} label={item.counterparty} />
                      ) : (
                        item.counterparty
                      )}
                      {/* Not `text-warning`: `warning` is not a colour in the
                          preset, so that utility compiled to nothing. */}
                      {item.counterpartyIsOwnWallet ? (
                        <span className="text-caption text-muted-foreground">
                          {t('v3.review.list.field.toOwnWallet')}
                        </span>
                      ) : null}
                    </span>
                  ),
                },
              ]
            : []),
          ...(item.explorerTxUrl
            ? [
                {
                  label: t('v3.review.list.field.transaction'),
                  value: (
                    <ExternalRef
                      href={item.explorerTxUrl}
                      label={t('v3.review.list.field.viewOnExplorer')}
                    />
                  ),
                },
              ]
            : []),
          ...(item.description
            ? [{ label: t('v3.review.list.field.description'), value: item.description }]
            : []),
        ],
        /* The answers, and then the sentence about the address they are all
           about (SC-375). The rule action sits BELOW them because it answers
           nothing: this transfer still needs one of the four, and a control
           that looks like a fifth answer would be read as one. */
        content: (
          <div className="flex flex-col gap-4">
            <TransferDecision item={item} onResolved={() => navigate(TRANSFER_REVIEW_PATH)} />
            <TransferRuleAction item={item} onHidden={() => navigate(TRANSFER_REVIEW_PATH)} />
          </div>
        ),
      }),
    },
  };

  return <V3DataView config={config} getId={(item) => item.transactionId} query={query} />;
}
