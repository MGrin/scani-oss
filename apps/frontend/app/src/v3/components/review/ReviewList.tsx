import { formatRelative } from '@scani/shared';
import { Button } from '@scani/ui/ui/button';
import { V3DataView } from '@scani/ui/v3/components/data-view/V3DataView';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import { rowName, type V3DataViewConfig } from '@scani/ui/v3/lib/data-view';
import { BLANK_CELL, exportDateTime, exportMoney } from '@scani/ui/v3/lib/export/cell';
import { resolveNumeric } from '@scani/ui/v3/lib/numeric';
import type { V3QueryState } from '@scani/ui/v3/lib/query-state';
import { CheckCircle2 } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import {
  compareReviewItems,
  type ReviewRow,
  reviewHref,
  reviewKindOptions,
  reviewMatches,
  splitReviewSubtitle,
} from '../../lib/review';
import { V3_ROUTES } from '../../lib/routes';

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
  items: ReviewRow[];
  query: V3QueryState;
}

export function ReviewList({ items, query }: ReviewListProps) {
  const navigate = useNavigate();
  const kindOptions = reviewKindOptions(items);

  const config: V3DataViewConfig<ReviewRow> = {
    pageKey: 'review',
    data: items,
    noun: 'items',
    nounSingular: 'item',
    searchPlaceholder: 'Search review',
    searchFn: reviewMatches,
    // One kind is not a dimension — a filter whose only option is "everything
    // currently on screen" is a control that cannot change the view.
    filterDefs:
      kindOptions.length > 1
        ? [
            {
              key: 'kind',
              label: 'Type',
              options: kindOptions,
              fn: (item: ReviewRow, value) => item.kind === value,
            },
          ]
        : [],
    sortDefs: [
      { key: 'arrived', label: 'Arrived' },
      { key: 'title', label: 'Item' },
    ],
    sortFn: compareReviewItems,
    defaultSort: { field: 'arrived', direction: 'desc' },
    groupByDefs: [{ key: 'kind', label: 'Type', fn: (item: ReviewRow) => item.title }],
    // The value zone holds the *value* — SC-71 10.3. It used to hold the
    // arrival time, on the reading that the time is the only figure a review
    // item has; the invoice rows disproved that, and they were spelling their
    // amount inline in the subtitle as `87.31 EUR` while every other list in
    // v3 right-aligns a `<Numeric>`. The time moves to the delta zone, which
    // is where the jobs list — the nearest sibling surface — already puts it.
    renderRow: (item) => {
      const { detail, amount } = splitReviewSubtitle(item.subtitle);
      return {
        label: item.title,
        sublabel: detail ?? undefined,
        value: amount ? <Numeric value={amount.value} currency={amount.currency} /> : null,
        delta: <span className="text-muted-foreground">{formatRelative(item.createdAt)}</span>,
        ariaLabel: rowName([
          item.title,
          detail,
          amount ? resolveNumeric(amount.value, { currency: amount.currency }).text : null,
          formatRelative(item.createdAt),
        ]),
      };
    },
    columns: [
      { key: 'title', header: 'Item', sortable: true, render: (item) => item.title },
      {
        key: 'subtitle',
        header: 'Detail',
        render: (item) => (
          <span className="truncate text-muted-foreground">
            {splitReviewSubtitle(item.subtitle).detail ?? '—'}
          </span>
        ),
      },
      {
        key: 'amount',
        header: 'Amount',
        numeric: true,
        width: 'w-36',
        render: (item) => {
          const { amount } = splitReviewSubtitle(item.subtitle);
          // A blank cell, not a dash: a dash is v3's "we have no value for
          // this", and most review kinds are not the sort of thing that has
          // one. The column is empty because the row is not about money.
          return amount ? <Numeric value={amount.value} currency={amount.currency} /> : null;
        },
        exportValue: (item) => {
          const { amount } = splitReviewSubtitle(item.subtitle);
          return amount ? exportMoney(amount.value, amount.currency) : BLANK_CELL;
        },
        exportTotal: true,
      },
      {
        key: 'arrived',
        header: 'Arrived',
        sortable: true,
        width: 'w-40',
        render: (item) => (
          <span className="text-muted-foreground">{formatRelative(item.createdAt)}</span>
        ),
        exportValue: (item) => exportDateTime(item.createdAt),
      },
    ],
    empty: {
      icon: CheckCircle2,
      title: 'Nothing needs your review',
      description:
        'Imports land here when they finish and want a confirmation before their holdings count.',
      action: (
        <Button asChild variant="outline">
          <Link to={V3_ROUTES.jobs}>See all jobs</Link>
        </Button>
      ),
    },
    onRowClick: (item) => navigate(reviewHref(item.href)),
    rowHref: (item) => reviewHref(item.href),
  };

  return <V3DataView config={config} getId={(item) => item.id} query={query} />;
}
