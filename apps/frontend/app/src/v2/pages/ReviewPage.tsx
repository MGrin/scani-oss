import { formatRelative } from '@scani/shared';
import { CardInteractive } from '@scani/ui/ui/card';
import { CheckCircle2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { counterpartPath } from '@/v3/lib/ui-version';
import { DataView as DataViewComponent } from '../components/data-view/DataView';
import type { ColumnDef } from '../components/data-view/DataViewTable';
import { type ReviewFeedItem, useReviewFeed } from '../hooks/useReviewFeed';

function ReviewCard({ item }: { item: ReviewFeedItem }) {
  return (
    <CardInteractive className="p-4">
      <div className="flex flex-col gap-1">
        <span className="font-medium text-sm truncate">{item.title}</span>
        {item.subtitle && (
          <span className="text-muted-foreground text-xs truncate">{item.subtitle}</span>
        )}
        <span className="text-muted-foreground text-xs">{formatRelative(item.createdAt)}</span>
      </div>
    </CardInteractive>
  );
}

/**
 * Everything waiting on the user, from every producer. Each row links to
 * the surface that owns the item; this page never mutates review state.
 */
export function ReviewPage() {
  const navigate = useNavigate();
  const { items, isLoading } = useReviewFeed();

  const kindOptions = Array.from(
    new Map(items.map((item) => [item.kind, item.title])),
    ([value, label]) => ({ label, value })
  );

  const columns: ColumnDef<ReviewFeedItem>[] = [
    {
      key: 'title',
      label: 'Item',
      sortable: true,
      render: (item) => <span className="font-medium text-sm">{item.title}</span>,
    },
    {
      key: 'subtitle',
      label: 'Detail',
      render: (item) => (
        <span className="text-sm text-muted-foreground">{item.subtitle ?? '—'}</span>
      ),
    },
    {
      key: 'arrived',
      label: 'Arrived',
      sortable: true,
      render: (item) => (
        <span className="text-sm text-muted-foreground">{formatRelative(item.createdAt)}</span>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Review</h2>
        <p className="text-muted-foreground mt-1">{isLoading ? '' : `${items.length} items`}</p>
      </div>

      <DataViewComponent
        config={{
          pageKey: 'review',
          data: items,
          searchFn: (item: ReviewFeedItem, query: string) => {
            const q = query.toLowerCase();
            return (
              item.title.toLowerCase().includes(q) ||
              (item.subtitle ?? '').toLowerCase().includes(q)
            );
          },
          filterDefs:
            kindOptions.length > 1
              ? [
                  {
                    key: 'kind',
                    label: 'Type',
                    options: kindOptions,
                    fn: (item: ReviewFeedItem, value: string) => item.kind === value,
                  },
                ]
              : [],
          sortDefs: [
            { key: 'title', label: 'Item' },
            { key: 'arrived', label: 'Arrived' },
          ],
          sortFn: (a: ReviewFeedItem, b: ReviewFeedItem, field: string, dir: string) => {
            const mult = dir === 'asc' ? 1 : -1;
            switch (field) {
              case 'title':
                return a.title.localeCompare(b.title) * mult;
              case 'arrived':
                return (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()) * mult;
              default:
                return 0;
            }
          },
          defaultSort: { field: 'arrived', direction: 'desc' },
          defaultView: 'table',
        }}
        columns={columns}
        renderCard={(item: ReviewFeedItem) => <ReviewCard item={item} />}
        // The feed's hrefs are unprefixed, and unprefixed is v3's namespace
        // since V3-19 — so a classic-UI row has to cross into `/v2` explicitly.
        onRowClick={(item: ReviewFeedItem) => navigate(counterpartPath(item.href, 'v2'))}
        getId={(item: ReviewFeedItem) => item.id}
        isLoading={isLoading}
        emptyState={
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <CheckCircle2 className="h-10 w-10 text-muted-foreground mb-3" />
            <h3 className="text-lg font-semibold">Nothing needs your review</h3>
            <p className="text-sm text-muted-foreground mt-1">You're all caught up.</p>
          </div>
        }
      />
    </div>
  );
}
