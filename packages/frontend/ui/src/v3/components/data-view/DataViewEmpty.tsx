import { Loader2, SearchX } from 'lucide-react';
import { useUiTranslation } from '../../../i18n';
import { Button } from '../../../ui/button';
import type { ActiveFilter, EmptyStateSpec } from '../../lib/data-view';
import { describeFilteredEmpty } from '../../lib/data-view';
import type { V3MoreState } from '../../lib/query-state';

/**
 * The two empty screens, which are not the same screen.
 *
 * v2 rendered one — "No items found" with an inbox icon, and a description
 * that changed if filters were active while the title and the (absent) action
 * did not. But *nothing here yet* and *your filter matched nothing* want
 * different actions: the first wants the button that creates the first record,
 * the second wants the button that undoes the narrowing. Sharing a component
 * is what made them share an action, which is why v2's has none.
 *
 * v3-local rather than `@scani/ui`'s `EmptyState`: that one sets the icon at
 * `text-muted-foreground/50`, and the opacity modifier is exactly the
 * composite that fails contrast at `HoldingCard.tsx:99` (research brief §2.6).
 * v2 is not ours to change, so v3 draws its own.
 */

function Frame({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: EmptyStateSpec['icon'];
  title: string;
  description?: string;
  action: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-12 text-center">
      <Icon className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
      <div className="flex flex-col gap-1">
        <p className="text-title">{title}</p>
        {description ? (
          <p className="mx-auto max-w-sm text-body text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {action}
    </div>
  );
}

export function DataViewEmpty({ empty }: { empty: EmptyStateSpec }) {
  const { t } = useUiTranslation();
  return (
    <Frame
      icon={empty.icon}
      title={t(empty.titleKey, empty.values)}
      description={empty.descriptionKey ? t(empty.descriptionKey, empty.values) : undefined}
      action={empty.action}
    />
  );
}

/**
 * `more` is the third empty screen (SC-244): the narrowing ran over a page.
 *
 * "Clear search and filters" is the wrong *primary* action there — clearing is
 * how you undo a narrowing that looked at everything, and here the thing to do
 * is widen what was looked at. So Load more leads and Clear follows, which is
 * the reverse of the settled case.
 */
export function DataViewFilteredEmpty({
  nounKey,
  searchTerm,
  activeFilters,
  onClearFilters,
  loadedCount = null,
  more = null,
}: {
  nounKey: string;
  searchTerm: string;
  activeFilters: ActiveFilter[];
  onClearFilters: () => void;
  loadedCount?: number | null;
  more?: V3MoreState | null;
}) {
  const { t } = useUiTranslation();
  const copy = describeFilteredEmpty(nounKey, searchTerm, activeFilters, loadedCount);

  return (
    <Frame
      icon={SearchX}
      title={copy.title}
      description={copy.description}
      action={
        <div className="flex flex-wrap items-center justify-center gap-2">
          {more ? <LoadMoreButton more={more} /> : null}
          <Button variant={more ? 'ghost' : 'outline'} onClick={onClearFilters}>
            {t('ui.dataView.empty.clearSearchAndFilters')}
          </Button>
        </div>
      }
    />
  );
}

/**
 * The one Load more control, drawn twice — under the rows and inside the empty
 * screen above.
 *
 * It lives here rather than on each page because SC-244's defect was a page
 * knowing its list was partial while the component rendering the list did not.
 * A page that owns the button owns that knowledge privately; a component that
 * owns it can spend it on the copy as well.
 */
export function LoadMoreButton({ more }: { more: V3MoreState }) {
  const { t } = useUiTranslation();
  return (
    <Button variant="outline" disabled={more.isFetching} onClick={more.fetch}>
      {more.isFetching ? <Loader2 className="me-2 size-4 animate-spin" aria-hidden="true" /> : null}
      {more.isFetching ? t('ui.dataView.toolbar.loadingMore') : t('ui.dataView.toolbar.loadMore')}
    </Button>
  );
}
