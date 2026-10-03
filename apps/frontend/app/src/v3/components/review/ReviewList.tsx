import { V3DataView } from '@scani/ui/v3/components/data-view/V3DataView';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import { rowName, type V3DataViewConfig } from '@scani/ui/v3/lib/data-view';
import { BLANK_CELL, exportDateTime, exportMoney } from '@scani/ui/v3/lib/export/cell';
import { resolveNumeric } from '@scani/ui/v3/lib/numeric';
import type { V3QueryState } from '@scani/ui/v3/lib/query-state';
import {
  AlertCircle,
  ArrowLeftRight,
  CheckCircle2,
  EyeOff,
  FileText,
  ListChecks,
  type LucideIcon,
  ReceiptText,
  Scale,
} from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { formatRelative } from '../../lib/relative-time';
import {
  compareReviewItems,
  type ReviewRow,
  reviewKindOptions,
  reviewMatches,
} from '../../lib/review';
import { type ReviewWireRow, toReviewRow, v3ReviewTexts } from '../../lib/review-text';

/**
 * Everything waiting on the user, from every producer.
 *
 * No peek. A review item is a *pointer* — its whole content is "this thing over
 * there needs you" — so opening it in a sheet would show a summary of a summary
 * and then need a second tap to reach the surface that can actually act. The
 * row navigates, which is what `onRowClick` is for.
 *
 * This page never mutates review state: the action always happens on the record
 * that owns it (a job's detail screen stamps `action_taken_at`), so there is one
 * copy of "is this still pending" rather than two that can disagree.
 */

interface ReviewListProps {
  items: ReviewWireRow[];
  /** A queue above still holds work, so an empty list means "nothing else". */
  queueHasWork: boolean;
  query: V3QueryState;
}

const REVIEW_ICONS: Record<ReviewRow['labelCode'], LucideIcon> = {
  invoiceExtracted: FileText,
  job: ListChecks,
  jobFailed: AlertCircle,
  transfersToConfirm: ArrowLeftRight,
  balanceChangesToExplain: Scale,
  answersTradesExplain: ReceiptText,
  unpriceableAirdrops: EyeOff,
};

export function ReviewList({ items, queueHasWork, query }: ReviewListProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  // The feed arrives as operands and is named here (SC-371) — once per render
  // rather than per cell, because the filter labels, the sort and the search
  // all read the same rendered words the reader does.
  const rows = useMemo(() => {
    const texts = v3ReviewTexts(t);
    return items.map((item) => toReviewRow(texts, item));
  }, [items, t]);
  const kindOptions = reviewKindOptions(rows);

  const config: V3DataViewConfig<ReviewRow> = {
    pageKey: 'review',
    data: rows,
    nounKey: 'ui.dataView.noun.reviewItems',
    searchPlaceholderKey: 'ui.dataView.review.config.searchReview',
    searchFn: reviewMatches,
    // One kind is not a dimension — a filter whose only option is "everything
    // currently on screen" is a control that cannot change the view.
    filterDefs:
      kindOptions.length > 1
        ? [
            {
              key: 'kind',
              labelKey: 'ui.dataView.review.filter.type',
              options: kindOptions,
              fn: (item: ReviewRow, value) => item.kind === value,
            },
          ]
        : [],
    sortDefs: [
      { key: 'arrived', labelKey: 'ui.dataView.review.sort.arrived' },
      { key: 'title', labelKey: 'ui.dataView.review.sort.item' },
    ],
    sortFn: compareReviewItems,
    defaultSort: { field: 'arrived', direction: 'desc' },
    groupByDefs: [
      {
        key: 'kind',
        labelKey: 'ui.dataView.review.group.type',
        fn: (item: ReviewRow) => item.title,
      },
    ],
    // The value zone holds the *value* — SC-71 10.3. It used to hold the
    // arrival time, on the reading that the time is the only figure a review
    // item has; the invoice rows disproved that, and they were spelling their
    // amount inline in the subtitle as `87.31 EUR` while every other list in
    // v3 right-aligns a `<Numeric>`. The time moves to the delta zone, which
    // is where the jobs list — the nearest sibling surface — already puts it.
    renderRow: (item) => ({
      // Every other list leads with a mark, so the text starts at one x down
      // the page (SC-1433). The icons are the ones those surfaces already use.
      leading: (() => {
        const Icon = REVIEW_ICONS[item.labelCode];
        return <Icon className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />;
      })(),
      label: item.title,
      sublabel: item.detail ?? undefined,
      // The detail line ends in what tells rows apart ("3 explanations on
      // IBKR Portfolio · USD"); truncated on a phone, two currencies read alike.
      wrapIdentity: true,
      value: item.amount ? (
        <Numeric value={item.amount.value} currency={item.amount.currency} />
      ) : null,
      delta: <span className="text-muted-foreground">{formatRelative(t, item.createdAt)}</span>,
      ariaLabel: rowName([
        item.title,
        item.detail,
        item.amount
          ? resolveNumeric(item.amount.value, { currency: item.amount.currency }).text
          : null,
        formatRelative(t, item.createdAt),
      ]),
    }),
    columns: [
      {
        key: 'title',
        headerKey: 'ui.dataView.review.col.item',
        sortable: true,
        render: (item) => item.title,
      },
      {
        key: 'subtitle',
        headerKey: 'ui.dataView.review.col.detail',
        render: (item) => (
          <span className="truncate text-muted-foreground">{item.detail ?? '—'}</span>
        ),
      },
      {
        key: 'amount',
        headerKey: 'ui.dataView.review.col.amount',
        numeric: true,
        width: 'w-36',
        // A blank cell, not a dash: a dash is v3's "we have no value for
        // this", and most review kinds are not the sort of thing that has
        // one. The column is empty because the row is not about money.
        render: (item) =>
          item.amount ? (
            <Numeric value={item.amount.value} currency={item.amount.currency} />
          ) : null,
        exportValue: (item) =>
          item.amount ? exportMoney(item.amount.value, item.amount.currency) : BLANK_CELL,
        exportTotal: true,
      },
      {
        key: 'arrived',
        headerKey: 'ui.dataView.review.col.arrived',
        sortable: true,
        width: 'w-40',
        render: (item) => (
          <span className="text-muted-foreground">{formatRelative(t, item.createdAt)}</span>
        ),
        exportValue: (item) => exportDateTime(item.createdAt),
      },
    ],
    empty: {
      icon: CheckCircle2,
      titleKey: queueHasWork
        ? 'ui.dataView.review.empty.nothingElse'
        : 'ui.dataView.review.empty.nothingNeedsYourReview',
      descriptionKey: queueHasWork
        ? 'ui.dataView.review.empty.theQueuesAboveHoldTheRest'
        : 'ui.dataView.review.empty.importsLandHereWhenTheyFinish',
      // Nothing to create from Review; Jobs is in the navigation (rule 8, SC-1433).
      action: null,
    },
    onRowClick: (item) => navigate(item.href),
    rowHref: (item) => item.href,
  };

  return <V3DataView config={config} getId={(item) => item.id} query={query} />;
}
